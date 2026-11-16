// `@ultimatelemon-eu/mcp-http/oauth`: the authorization server without the
// Node HTTP server, for frameworks that route requests themselves (Next.js).
export {
  createOAuthHandler,
  type OAuthGrant,
  type OAuthHandler,
  type OAuthOptions
} from './oauth.js';
export {
  DEFAULT_TRUSTED_HOSTS,
  type ClientIdMetadataOptions
} from './client-metadata.js';
export { oidcUpstream, type OidcUpstreamOptions } from './oidc.js';
export {
  oauth2Upstream,
  UpstreamError,
  type OAuth2UpstreamOptions,
  type OAuthUpstream,
  type UpstreamTokens
} from './upstream.js';
export {
  escapeHtml,
  htmlPage,
  htmlResponse,
  type SettingsField,
  type SettingsForm,
  type SettingsOption
} from './pages.js';
