import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderPermissionRequest, ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";

/**
 * Bridge between vibe's `ask_user_question` tool and Paseo's shared question card.
 *
 * vibe-acp only enables the tool when the ACP client advertises `elicitation.form`; it then
 * asks its questions with a client-bound `elicitation/create` request carrying a JSON Schema
 * of primitive fields: `q0`, `q1`… with `oneOf: [{const, title}]` for a single choice (type
 * "string") or `items.anyOf: [{const, title}]` for a multi select (type "array"), `title` =
 * header (may be empty, ≤ 20 chars) and `description` = the question text. Paseo renders a
 * `session.permission` of kind "question" and answers with `updatedInput.answers` keyed by
 * header (or by question text, depending on the client).
 *
 * Everything here is pure mapping: no I/O, no state, no logging.
 */

/** One in-flight `elicitation/create`, from the child's request to the user's answer. */
export interface PendingQuestion {
  /** JSON-RPC id of the child request; the answer is written back with it. */
  rpcId: string | number;
  /** Wire keys ("q0"…) in schema order. */
  keys: string[];
  /** Header published for each question: the card keys its answers on it. */
  headers: string[];
  /** Question texts, for clients that key answers on the text instead of the header. */
  questions: string[];
  /** Labels published for each question, to tell "one label with a comma" from a list. */
  labels: string[][];
  multiSelect: boolean[];
}

export interface QuestionFromElicitation {
  permission: ProviderPermissionRequest;
  pending: PendingQuestion;
}

/** Wire answer for the child, or "decline"/"cancel" when there is nothing deliverable. */
export type ElicitationResult =
  | { action: "accept"; content: Record<string, string | string[]> }
  | { action: "decline" }
  | { action: "cancel" };

const PERMISSION_PREFIX = "vibe-question:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Labels of a JSON Schema choice list: `const`/`value` (oneOf/anyOf) or a bare `enum`. */
function labelsOf(entries: unknown[], fallbackEnum: unknown): string[] {
  const labels = entries
    .map((entry) => (isRecord(entry) ? text(entry.const) ?? text(entry.value) ?? text(entry.title) : text(entry)))
    .filter((label): label is string => label !== undefined);
  if (labels.length > 0) return labels;
  return asArray(fallbackEnum)
    .map((entry) => text(entry))
    .filter((label): label is string => label !== undefined);
}

/** Header the card will key the answer on: the client uses a map, so it must be non-empty and unique. */
function headerFor(raw: string | undefined, index: number, used: Set<string>): string {
  const base = raw ?? `Q${index + 1}`;
  let header = base;
  let suffix = 2;
  while (used.has(header)) {
    header = `${base} (${suffix++})`;
  }
  used.add(header);
  return header;
}

/** One question as the model wrote it in the tool call, i.e. before the schema flattens it. */
interface RawToolQuestion {
  question?: string;
  descriptions: Map<string, string>;
  hideOther: boolean;
}

/**
 * vibe's own tool arguments, captured from the `tool_call` the model emits just before the
 * elicitation. They carry what the elicitation schema drops: option descriptions and
 * `hideOther`. Only the bits matching the schema are used (see `questionFromElicitation`).
 */
export function toolQuestions(toolInput: JsonValue | undefined): RawToolQuestion[] | null {
  const questions = asArray(asRecord(toolInput)?.questions);
  const parsed: RawToolQuestion[] = [];
  for (const entry of questions) {
    const question = asRecord(entry);
    if (!question) return null;
    const descriptions = new Map<string, string>();
    for (const option of asArray(question.options)) {
      const record = asRecord(option);
      const label = record ? text(record.label) : undefined;
      const description = record ? text(record.description) : undefined;
      if (label && description) descriptions.set(label, description);
    }
    parsed.push({
      question: text(question.question),
      descriptions,
      hideOther: question.hideOther === true || question.hide_other === true,
    });
  }
  return parsed.length > 0 ? parsed : null;
}

interface DraftQuestion {
  question: string;
  header: string;
  labels: string[];
  multiSelect: boolean;
}

/**
 * Build the permission request Paseo renders, plus the state needed to decode the answer.
 *
 * Returns null when the payload is not a form we can render (no properties, a malformed
 * field): the caller then declines the elicitation, so the model gets its turn back instead
 * of hanging on a request nobody will answer.
 */
export function questionFromElicitation(
  rpcId: string | number,
  params: unknown,
  nativeSessionId: string,
  toolInput?: JsonValue,
): QuestionFromElicitation | null {
  if (!isRecord(params)) return null;
  const mode = asRecord(params.mode);
  const schema = asRecord(params.requestedSchema) ?? (mode ? asRecord(mode.requestedSchema) : null);
  const properties = schema ? asRecord(schema.properties) : null;
  if (!schema || !properties) return null;
  const keys = Object.keys(properties);
  if (keys.length === 0) return null;

  const raw = toolQuestions(toolInput);
  const captured = raw && raw.length === keys.length ? raw : null;

  const drafts: DraftQuestion[] = [];
  const usedHeaders = new Set<string>();
  for (const [index, key] of keys.entries()) {
    const property = asRecord(properties[key]);
    if (!property) return null;
    const items = asRecord(property.items);
    const multiSelect = property.type === "array" || items !== null;
    const labels = multiSelect
      ? labelsOf(asArray(items?.anyOf ?? items?.one_of), items?.enum ?? property.enum)
      : labelsOf(asArray(property.oneOf ?? property.one_of), property.enum);
    drafts.push({
      question: text(property.description) ?? captured?.[index]?.question ?? text(property.title) ?? `Question ${index + 1}`,
      header: headerFor(text(property.title), index, usedHeaders),
      labels,
      multiSelect,
    });
  }

  // The captured tool arguments only describe the same questions when the texts match, in order.
  const enriched = captured !== null && drafts.every((draft, index) => captured[index]?.question === draft.question);

  const questions: JsonValue[] = drafts.map((draft, index) => {
    const options = draft.labels.map((label) => {
      const option: Record<string, JsonValue> = { label };
      const description = enriched ? captured[index]?.descriptions.get(label) : undefined;
      if (description) option.description = description;
      return option;
    });
    return {
      question: draft.question,
      header: draft.header,
      options,
      multiSelect: draft.multiSelect,
      // vibe adds an "Other" free-text choice to every question unless the model hides it.
      allowOther: enriched ? !(captured[index]?.hideOther ?? false) : true,
    };
  });

  const footerNote =
    text(schema.description) ?? text(asRecord(toolInput)?.footerNote) ?? undefined;

  const permission: ProviderPermissionRequest = {
    // Namespaced by session: two vibe-acp processes in one connection can reuse JSON-RPC ids.
    id: `${PERMISSION_PREFIX}${nativeSessionId}:${String(rpcId)}`,
    name: "ask_user_question",
    kind: "question",
    title: drafts[0]?.question,
    input: { questions },
  };
  if (footerNote) permission.description = footerNote;

  return {
    permission,
    pending: {
      rpcId,
      keys,
      headers: drafts.map((draft) => draft.header),
      questions: drafts.map((draft) => draft.question),
      labels: drafts.map((draft) => draft.labels),
      multiSelect: drafts.map((draft) => draft.multiSelect),
    },
  };
}

/** True when a tool_call's `rawInput` is vibe's `ask_user_question` argument object. */
export function isToolQuestionInput(value: unknown): value is JsonValue {
  return isRecord(value) && Array.isArray(value.questions);
}

/** True when this permission id was minted here; the ACP shim never sees those requests. */
export function isQuestionPermission(permissionId: string): boolean {
  return permissionId.startsWith(PERMISSION_PREFIX);
}

/**
 * Decode the card's answer into the elicitation content. vibe rejects an empty string or an
 * empty array for a field, so an unusable answer becomes "decline" instead of a protocol
 * error the model would see as a failed tool.
 */
export function answersFromPermission(
  pending: PendingQuestion,
  response: ProviderPermissionResponse,
): ElicitationResult {
  if (response.behavior !== "allow") return { action: "cancel" };
  const answers = asRecord(response.updatedInput?.answers);
  if (!answers) return { action: "decline" };
  const content: Record<string, string | string[]> = {};
  for (const [index, key] of pending.keys.entries()) {
    const answer = answers[pending.headers[index]] ?? answers[pending.questions[index]];
    const value = typeof answer === "string" ? answer.trim() : "";
    if (pending.multiSelect[index]) {
      const labels = pending.labels[index];
      const picked = labels.includes(value)
        ? [value]
        : value
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
      if (picked.length === 0) return { action: "decline" };
      content[key] = picked;
    } else {
      if (value.length === 0) return { action: "decline" };
      content[key] = value;
    }
  }
  return { action: "accept", content };
}
