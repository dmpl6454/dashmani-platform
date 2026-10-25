/**
 * Creator portal — Facebook Login configuration.
 *
 * ⚠️ SEPARATE FROM services/meta-oauth/meta-config.ts ON PURPOSE. The admin flow asks for a
 * READ-ONLY scope set and its tests lock that no publish scope ever appears in its authorize URL.
 * Creators connect so we can (in Phase B) post bookings to their pages, so they need the publish
 * scopes — but nothing that reads their inbox, comments or ad accounts. Two lists, two tests.
 *
 * The app defaults to the admin one ("Post Automation 2", META_OAUTH_APP_ID/SECRET) and can be
 * split out with CREATOR_META_APP_ID/SECRET without a deploy. The redirect URI is creator-only and
 * has NO default: unset ⇒ connect answers 503 META_NOT_CONFIGURED (the dark switch).
 */

import { metaOauthAppId, metaOauthAppSecret } from "../meta-oauth/meta-config";
import { tokenCryptoConfigured } from "../../utils/token-crypto";
import { creatorConfig } from "./creator-config";

/** Everything a creator is asked for. Publishing (Phase B) + the insights behind the page stats. */
export const CREATOR_META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "read_insights",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
] as const;

/**
 * Never requested from a creator. Comments, messages and ad accounts are none of our business;
 * `email` we already have; `business_management` would expose the creator's whole Business
 * Manager; `publish_video` is a legacy scope pages_manage_posts covers. Locked by a test.
 */
export const CREATOR_FORBIDDEN_SCOPES = [
  "pages_manage_engagement",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "ads_management",
  "ads_read",
  "email",
  "business_management",
  "publish_video",
] as const;

export function creatorMetaAppId(): string {
  return (process.env.CREATOR_META_APP_ID ?? "").trim() || metaOauthAppId();
}

export function creatorMetaAppSecret(): string {
  return (process.env.CREATOR_META_APP_SECRET ?? "").trim() || metaOauthAppSecret();
}

/** Must byte-match a Valid OAuth Redirect URI in the App Dashboard (never derived from the request). */
export function creatorMetaRedirectUri(): string {
  return (process.env.META_CREATOR_REDIRECT_URI ?? "").trim();
}

/**
 * Where the callback sends the creator back. Fixed path on the creators origin; only the query
 * varies and it is always one of our own literal codes — there is no caller-supplied return URL.
 */
export function creatorMetaReturnUrl(search: string): string {
  return `${creatorConfig.appUrl()}/connect${search}`;
}

export function creatorMetaMissingEnv(): string[] {
  const missing: string[] = [];
  if (!creatorMetaAppId()) missing.push("CREATOR_META_APP_ID (or META_OAUTH_APP_ID)");
  if (!creatorMetaAppSecret()) missing.push("CREATOR_META_APP_SECRET (or META_OAUTH_APP_SECRET)");
  if (!creatorMetaRedirectUri()) missing.push("META_CREATOR_REDIRECT_URI");
  if (!tokenCryptoConfigured()) missing.push("META_TOKEN_ENC_KEY");
  return missing;
}

/** Dark switch: with any var missing no state row is written and no Graph call is made. */
export function creatorMetaConfigured(): boolean {
  return creatorMetaMissingEnv().length === 0;
}
