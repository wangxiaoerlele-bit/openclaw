import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { hasConfiguredSecretInput, type ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "./secret-input.js";
import type {
  FeishuConfig,
  FeishuAccountConfig,
  FeishuDefaultAccountSelectionSource,
  FeishuDomain,
  ResolvedFeishuAccount,
} from "./types.js";

const FEISHU_ACCOUNT_ONLY_KEYS = new Set([
  "enabled",
  "name",
  "appId",
  "appSecret",
  "encryptKey",
  "verificationToken",
  "domain",
  "connectionMode",
  "webhookHost",
  "webhookPath",
  "webhookPort",
  // Accepted in real-world configs even though not yet modeled in the zod schema.
  "botName",
]);

function resolveBaseFeishuConfig(cfg: ClawdbotConfig): FeishuConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...base } = feishuCfg ?? {};
  return base as FeishuConfig;
}

function resolveDefaultAccountConfig(cfg: ClawdbotConfig): FeishuAccountConfig | undefined {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[DEFAULT_ACCOUNT_ID];
}

function hasConfiguredAppId(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasConcreteFeishuCredentials(cfg?: Partial<FeishuAccountConfig | FeishuConfig>): boolean {
  return hasConfiguredAppId(cfg?.appId) && hasConfiguredSecretInput(cfg?.appSecret);
}

function shouldTreatDefaultAccountAsSharedDefaults(cfg: ClawdbotConfig): boolean {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return false;
  }
  const normalizedIds = Object.keys(accounts)
    .map((accountId) => normalizeAccountId(accountId))
    .filter(Boolean);
  const hasNamedAccounts = normalizedIds.some((accountId) => accountId !== DEFAULT_ACCOUNT_ID);
  if (!hasNamedAccounts) {
    return false;
  }
  if (hasConcreteFeishuCredentials(resolveBaseFeishuConfig(cfg))) {
    return false;
  }
  return !hasConcreteFeishuCredentials(resolveDefaultAccountConfig(cfg));
}

function resolveSharedDefaultAccountConfig(cfg: ClawdbotConfig): FeishuAccountConfig | undefined {
  if (!shouldTreatDefaultAccountAsSharedDefaults(cfg)) {
    return undefined;
  }
  const defaultAccount = resolveDefaultAccountConfig(cfg);
  if (!defaultAccount) {
    return undefined;
  }
  const sharedDefaults = { ...defaultAccount } as Record<string, unknown>;
  for (const key of FEISHU_ACCOUNT_ONLY_KEYS) {
    delete sharedDefaults[key];
  }
  return sharedDefaults as FeishuAccountConfig;
}

/**
 * List all configured account IDs from the accounts field.
 */
function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  const treatDefaultAsSharedDefaults = shouldTreatDefaultAccountAsSharedDefaults(cfg);
  for (const accountId of Object.keys(accounts)) {
    if (!accountId) {
      continue;
    }
    const normalized = normalizeAccountId(accountId);
    if (treatDefaultAsSharedDefaults && normalized === DEFAULT_ACCOUNT_ID) {
      continue;
    }
    ids.add(normalized);
  }
  return [...ids];
}

/**
 * List all Feishu account IDs.
 * If no accounts are configured, returns [DEFAULT_ACCOUNT_ID] for backward compatibility.
 */
export function listFeishuAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    // Backward compatibility: no accounts configured, use default
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve the default account selection and its source.
 */
export function resolveDefaultFeishuAccountSelection(cfg: ClawdbotConfig): {
  accountId: string;
  source: FeishuDefaultAccountSelectionSource;
} {
  const preferredRaw = (cfg.channels?.feishu as FeishuConfig | undefined)?.defaultAccount?.trim();
  const preferred = preferredRaw ? normalizeAccountId(preferredRaw) : undefined;
  if (preferred) {
    return {
      accountId: preferred,
      source: "explicit-default",
    };
  }
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      source: "mapped-default",
    };
  }
  return {
    accountId: ids[0] ?? DEFAULT_ACCOUNT_ID,
    source: "fallback",
  };
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  return resolveDefaultFeishuAccountSelection(cfg).accountId;
}

/**
 * Get the raw account-specific config.
 */
function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): FeishuAccountConfig | undefined {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

/**
 * Merge top-level config with account-specific config.
 * Account-specific fields override top-level fields.
 */
function mergeFeishuAccountConfig(cfg: ClawdbotConfig, accountId: string): FeishuConfig {
  const base = resolveBaseFeishuConfig(cfg);
  const sharedDefaults =
    accountId === DEFAULT_ACCOUNT_ID ? undefined : resolveSharedDefaultAccountConfig(cfg);
  // Get account-specific overrides
  const account = resolveAccountConfig(cfg, accountId) ?? {};

  // Merge: per-account config overrides shared defaults, which override channel-wide config.
  return { ...base, ...sharedDefaults, ...account } as FeishuConfig;
}

/**
 * Resolve Feishu credentials from a config.
 */
export function resolveFeishuCredentials(cfg?: FeishuConfig): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null;
export function resolveFeishuCredentials(
  cfg: FeishuConfig | undefined,
  options: { allowUnresolvedSecretRef?: boolean },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null;
export function resolveFeishuCredentials(
  cfg?: FeishuConfig,
  options?: { allowUnresolvedSecretRef?: boolean },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const normalizeString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };

  const resolveSecretLike = (value: unknown, path: string): string | undefined => {
    const asString = normalizeString(value);
    if (asString) {
      return asString;
    }

    // In relaxed/onboarding paths only: allow direct env SecretRef reads for UX.
    // Default resolution path must preserve unresolved-ref diagnostics/policy semantics.
    if (options?.allowUnresolvedSecretRef && typeof value === "object" && value !== null) {
      const rec = value as Record<string, unknown>;
      const source = normalizeString(rec.source)?.toLowerCase();
      const id = normalizeString(rec.id);
      if (source === "env" && id) {
        const envValue = normalizeString(process.env[id]);
        if (envValue) {
          return envValue;
        }
      }
    }

    if (options?.allowUnresolvedSecretRef) {
      return normalizeSecretInputString(value);
    }
    return normalizeResolvedSecretInputString({ value, path });
  };

  const appId = resolveSecretLike(cfg?.appId, "channels.feishu.appId");
  const appSecret = resolveSecretLike(cfg?.appSecret, "channels.feishu.appSecret");

  if (!appId || !appSecret) {
    return null;
  }
  return {
    appId,
    appSecret,
    encryptKey: normalizeString(cfg?.encryptKey),
    verificationToken: resolveSecretLike(
      cfg?.verificationToken,
      "channels.feishu.verificationToken",
    ),
    domain: cfg?.domain ?? "feishu",
  };
}

/**
 * Resolve a complete Feishu account with merged config.
 */
export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const hasExplicitAccountId =
    typeof params.accountId === "string" && params.accountId.trim() !== "";
  const defaultSelection = hasExplicitAccountId
    ? null
    : resolveDefaultFeishuAccountSelection(params.cfg);
  const accountId = hasExplicitAccountId
    ? normalizeAccountId(params.accountId)
    : (defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID);
  const selectionSource = hasExplicitAccountId
    ? "explicit"
    : (defaultSelection?.source ?? "fallback");
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;

  // Base enabled state (top-level)
  const baseEnabled = feishuCfg?.enabled !== false;

  // Merge configs
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);

  // Account-level enabled state
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  // Resolve credentials from merged config
  const creds = resolveFeishuCredentials(merged);
  const accountName = (merged as FeishuAccountConfig).name;

  return {
    accountId,
    selectionSource,
    enabled,
    configured: Boolean(creds),
    name: typeof accountName === "string" ? accountName.trim() || undefined : undefined,
    appId: creds?.appId,
    appSecret: creds?.appSecret,
    encryptKey: creds?.encryptKey,
    verificationToken: creds?.verificationToken,
    domain: creds?.domain ?? "feishu",
    config: merged,
  };
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
