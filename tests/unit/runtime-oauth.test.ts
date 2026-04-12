import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { withEnv } from "../helpers/envGuards.js";
import {
  authorizationRequestFromConfig,
  buildAuthorizationUrl,
  clearOauthCredentials,
  codeChallengeS256,
  credentialsPath,
  exchangeOAuthCode,
  generatePkcePair,
  generateState,
  loadOauthCredentials,
  loopbackRedirectUri,
  oauthTokenIsExpired,
  parseOauthCallbackQuery,
  parseOauthCallbackRequestTarget,
  refreshFormParams,
  refreshRequestFromConfig,
  saveOauthCredentials,
  tokenExchangeFormParams,
  tokenExchangeRequestFromConfig,
  withAuthorizationExtraParam
} from "../../src/runtime/oauth.js";

describe("runtime oauth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("ports oauth utility behavior", async () => {
    const config = {
      clientId: "runtime-client",
      authorizeUrl: "https://console.test/oauth/authorize",
      tokenUrl: "https://console.test/oauth/token",
      callbackPort: 4545,
      manualRedirectUrl: "https://console.test/oauth/callback",
      scopes: ["org:read", "user:write"]
    };

    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );

    const pair = generatePkcePair();
    const state = generateState();
    expect(pair.verifier.length).toBeGreaterThan(0);
    expect(pair.challenge.length).toBeGreaterThan(0);
    expect(state.length).toBeGreaterThan(0);

    const url = buildAuthorizationUrl(
      withAuthorizationExtraParam(
        authorizationRequestFromConfig(config, loopbackRedirectUri(4545), "state-123", pair),
        "login_hint",
        "user@example.com"
      )
    );
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=runtime-client");
    expect(url).toContain("login_hint=user%40example.com");

    const exchange = tokenExchangeRequestFromConfig(
      config,
      "auth-code",
      "state-123",
      pair.verifier,
      loopbackRedirectUri(4545)
    );
    expect(tokenExchangeFormParams(exchange).grant_type).toBe("authorization_code");

    const refresh = refreshRequestFromConfig(config, "refresh-token");
    expect(refreshFormParams(refresh).scope).toBe("org:read user:write");

    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-oauth-"));
    await withEnv({ CLENCH_CONFIG_HOME: configHome }, async () => {
      expect(credentialsPath()).toBe(path.join(configHome, "credentials.json"));
      saveOauthCredentials({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: 123,
        scopes: ["scope:a"]
      });
      expect(loadOauthCredentials()).toEqual({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: 123,
        scopes: ["scope:a"]
      });
      clearOauthCredentials();
      expect(loadOauthCredentials()).toBeUndefined();
    });
    fs.rmSync(configHome, { recursive: true, force: true });

    expect(parseOauthCallbackQuery("code=abc123&state=state-1&error_description=needs+login")).toEqual({
      code: "abc123",
      state: "state-1",
      errorDescription: "needs login"
    });
    expect(parseOauthCallbackRequestTarget("/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz"
    });
    expect(() => parseOauthCallbackRequestTarget("/wrong?code=abc")).toThrow("unexpected callback path");

    const past = Math.floor(Date.now() / 1000) - 1;
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(oauthTokenIsExpired({ accessToken: "a", scopes: [], expiresAt: past })).toBe(true);
    expect(oauthTokenIsExpired({ accessToken: "a", scopes: [], expiresAt: future })).toBe(false);
    expect(oauthTokenIsExpired({ accessToken: "a", scopes: [] })).toBe(false);
  });

  test("exchange_oauth_code_posts_form_and_normalizes_token_set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: "org:read user:write"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      )
    );

    const tokenSet = await exchangeOAuthCode(
      {
        clientId: "runtime-client",
        authorizeUrl: "https://console.test/oauth/authorize",
        tokenUrl: "https://console.test/oauth/token",
        scopes: ["org:read", "user:write"]
      },
      {
        grantType: "authorization_code",
        code: "auth-code",
        redirectUri: "http://localhost:4545/callback",
        clientId: "runtime-client",
        codeVerifier: "verifier-123",
        state: "state-123"
      }
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(String(init?.body)).toContain("grant_type=authorization_code");
    expect(String(init?.body)).toContain("code=auth-code");
    expect(String(init?.body)).toContain("code_verifier=verifier-123");
    expect(tokenSet.accessToken).toBe("access-token");
    expect(tokenSet.refreshToken).toBe("refresh-token");
    expect(tokenSet.scopes).toEqual(["org:read", "user:write"]);
    expect(tokenSet.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
