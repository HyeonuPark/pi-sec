/**
 * A model provider extension, for tests only.
 *
 * It exports both entry forms a `providers` export may carry:
 *
 * - `{ id, config }`, the `ProviderConfig` form, with a `streamSimple` that
 *   answers from a fixed text and an `oauth` block whose login flow returns
 *   credentials without a browser or a network call,
 * - a complete `Provider` object, the native form, with its own `auth`,
 *   `getModels` and `streamSimple`.
 *
 * `providers` is a function, so it also proves that the export receives the
 * extension's validated `config.json` value: the answer text and the provider id
 * come from that file.
 *
 * Nothing here reaches the network, and every credential is a fake.
 */
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const CONFIG_API = "acme-fake-api";
const NATIVE_API = "acme-native-api";

/** Fixed fake credentials, long enough for the secret store to keep them in a file. */
const FAKE_ACCESS = "fake-acme-oauth-access-0000000000000000";
const FAKE_REFRESH = "fake-acme-oauth-refresh-000000000000000";

export const name = "acme";

export const configSchema = Type.Object({
  /** Text the fake provider answers with. */
  answer: Type.String(),
  /** Id the config-form provider registers under. Defaults to the extension name. */
  id: Type.Optional(Type.String()),
  /** Refuse to load, to prove a failed reload keeps the previous registration. */
  broken: Type.Optional(Type.Boolean()),
});

/**
 * One streamed answer. The event sequence is the one pi-ai's own faux provider
 * emits, cut down to a single text block.
 */
function answerStream(model, text) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const partial = { ...message, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial: { ...partial } });
  stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial, content: [{ type: "text", text: "" }] } });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: { ...partial, content: [{ type: "text", text }] },
  });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: { ...partial, content: [{ type: "text", text }] } });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

function chatModel(providerId, id, api) {
  return {
    id,
    name: `Acme ${id}`,
    api,
    provider: providerId,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
    reasoning: false,
  };
}

/** The complete-provider form. Nothing composes it: the runtime uses it as it is. */
function nativeProvider(answer) {
  return {
    id: "acme-native",
    name: "Acme Native",
    auth: {
      apiKey: {
        name: "Acme native API key",
        async login(interaction) {
          return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter Acme native API key" }) };
        },
        async resolve(input) {
          if (input.credential?.key) return { auth: { apiKey: input.credential.key }, source: "stored credential" };
          return { auth: { apiKey: "fake-native-key" }, source: "fixture" };
        },
      },
    },
    getModels() {
      return [chatModel("acme-native", "acme-native-chat", NATIVE_API)];
    },
    stream(model) {
      return answerStream(model, answer);
    },
    streamSimple(model) {
      return answerStream(model, answer);
    },
  };
}

/** The config-pair form: what `registerProvider(id, config)` takes. */
function providerConfig(config) {
  const id = config.id ?? "acme";
  return {
    name: "Acme (fake)",
    // Never contacted: `streamSimple` answers every request. The runtime requires
    // an endpoint before it will register custom models.
    baseUrl: "http://127.0.0.1:1/v1",
    api: CONFIG_API,
    // A literal dummy key: the runtime treats the provider as configured, so a
    // daemon on this model answers without a login. A stored credential still
    // wins over it, which is what the login tests write.
    apiKey: "fake-acme-config-key",
    streamSimple(model) {
      return answerStream(model, config.answer);
    },
    models: [chatModel(id, "acme-fake-chat", CONFIG_API)],
    oauth: {
      name: "Acme (fake OAuth)",
      async login() {
        return { access: FAKE_ACCESS, refresh: FAKE_REFRESH, expires: Date.now() + 3_600_000 };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  };
}

export function providers(config) {
  if (config.broken === true) throw new Error("acme: broken is set in config.json");
  return [{ id: config.id ?? "acme", config: providerConfig(config) }, nativeProvider(config.answer)];
}

export function create(config) {
  return {
    name: "acme",
    sections: [{ key: "acme", render: () => `acme extension loaded: ${config.answer}` }],
  };
}
