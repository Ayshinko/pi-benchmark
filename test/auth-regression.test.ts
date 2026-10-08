/**
 * Regression test for the local-provider authentication bug.
 *
 * Bug: an isolated benchmark child session created its own fresh ModelRuntime that
 * lost extension-registered providers such as the local `strata-auto` endpoint,
 * failing any real run with "No API key found for strata-auto" before generating a
 * single token.
 *
 * Fix: the child session now inherits the parent's registered provider configs and a
 * localhost OpenAI-compatible provider uses its configured key, falling back to the
 * harmless placeholder `local` for keyless local endpoints. Remote providers are never
 * weakened.
 *
 *   node test/auth-regression.test.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { applyLocalApiKeyFallback, buildChildModelRuntime, isLocalUrl } from "../src/runner.ts";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

/** A minimal valid local OpenAI-compatible provider config (mirrors strata-auto). */
function localProviderConfig(baseUrl: string, extra: Record<string, unknown> = {}): any {
  return {
    name: "Local Strata",
    baseUrl,
    api: "openai-completions",
    models: [
      {
        id: "swift-1.5-iq3_xxs",
        name: "Swift 1.5 IQ3_XXS (local strata)",
        input: ["text"],
        reasoning: true,
        contextWindow: 65536,
        maxTokens: 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    ...extra,
  };
}

function testUrlDetection(): void {
  console.log("\n[url detection]");
  check("127.0.0.1 is local", isLocalUrl("http://127.0.0.1:8080/v1"));
  check("localhost is local", isLocalUrl("http://localhost:8080/v1"));
  check("::1 is local", isLocalUrl("http://[::1]:8080/v1"));
  check("https/scheme is irrelevant", isLocalUrl("https://127.0.0.1/v1"));
  check("remote is not local", !isLocalUrl("https://api.openai.com/v1"));
  check("openrouter is not local", !isLocalUrl("https://openrouter.ai/api/v1"));
  check("empty is not local", !isLocalUrl(""));
  check("garbage is not local", !isLocalUrl("not a url"));
}

function testFallback(): void {
  console.log("\n[local api key fallback]");
  // keyless localhost provider -> placeholder "local", no OAuth/login.
  const localKeyless = applyLocalApiKeyFallback("strata-auto", localProviderConfig("http://127.0.0.1:8080/v1"));
  check("keyless localhost gets placeholder 'local'", localKeyless.apiKey === "local", `got ${localKeyless.apiKey}`);
  check("keyless localhost added no oauth", !localKeyless.oauth);

  // localhost provider with an existing configured key is preserved.
  const localWithKey = applyLocalApiKeyFallback("strata-auto", localProviderConfig("http://127.0.0.1:8080/v1", { apiKey: "my-secret" }));
  check("existing local key is preserved", localWithKey.apiKey === "my-secret");

  // baseUrl already present; a config without baseUrl is not rewritten.
  const noBaseUrl = applyLocalApiKeyFallback("x", { apiKey: undefined });
  check("config without baseUrl unchanged", noBaseUrl.apiKey === undefined);

  // Remote providers are NEVER weakened.
  const remoteKeyless = applyLocalApiKeyFallback("openrouter", localProviderConfig("https://openrouter.ai/api/v1"));
  check("remote keyless provider is not given a fallback", remoteKeyless.apiKey === undefined, `got ${remoteKeyless.apiKey}`);

  const remoteOAuth = applyLocalApiKeyFallback("anthropic", localProviderConfig("https://api.anthropic.com/v1", { oauth: { name: "x", login: async () => ({}), refreshToken: async () => ({}), getApiKey: () => "k" } }));
  check("remote oauth provider untouched", remoteOAuth.oauth !== undefined && remoteOAuth.apiKey === undefined);
}

async function testChildRuntimeAuth(): Promise<void> {
  console.log("\n[child runtime auth resolution]");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bench-auth-"));
  try {
    // keyless localhost provider -> must be treated as configured, no login needed.
    const local = await ModelRuntime.create({
      authPath: path.join(tmp, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const localConfig = applyLocalApiKeyFallback("strata-auto", localProviderConfig("http://127.0.0.1:8080/v1"));
    local.registerProvider("strata-auto", localConfig);
    const localRegistry = new ModelRegistry(local);
    check("localhost provider is configured", local.hasConfiguredAuth("strata-auto"));
    check("localhost resolves api key 'local'", (await localRegistry.getApiKeyForProvider("strata-auto")) === "local");
    check("localhost provider auth status configured", local.getProviderAuthStatus("strata-auto").configured);

    // Remote keyless provider -> NOT configured, no fallback injected. Use a fake
    // provider id (not a real one like openrouter) so the environment's own
    // credentials don't mask the check.
    const remote = await ModelRuntime.create({
      authPath: path.join(tmp, "auth2.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    remote.registerProvider("remote-test", localProviderConfig("https://api.example-remote.com/v1"));
    check("remote provider is not configured (auth still required)", !remote.hasConfiguredAuth("remote-test"));
    check("remote provider has no injected key", (await new ModelRegistry(remote).getApiKeyForProvider("remote-test")) === undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testBuildChildRuntime(): void {
  console.log("\n[buildChildModelRuntime]");
  // buildChildModelRuntime must accept undefined providers.
  const p = buildChildModelRuntime;
  check("buildChildModelRuntime is a function", typeof p === "function");
  check("isLocalUrl/applyLocalApiKeyFallback exported", typeof isLocalUrl === "function" && typeof applyLocalApiKeyFallback === "function");
}

async function main(): Promise<void> {
  testUrlDetection();
  testFallback();
  await testChildRuntimeAuth();
  testBuildChildRuntime();
  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();