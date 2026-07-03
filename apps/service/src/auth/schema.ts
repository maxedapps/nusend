export const authSchema = {
  user: {
    modelName: "users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    modelName: "sessions",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  account: {
    modelName: "accounts",
    fields: {
      providerId: "provider_id",
      accountId: "account_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
} as const;

export const organizationSchema = {
  session: {
    fields: {
      activeOrganizationId: "active_organization_id",
    },
  },
  organization: {
    modelName: "organizations",
    fields: {
      createdAt: "created_at",
    },
  },
  member: {
    modelName: "organization_members",
    fields: {
      organizationId: "organization_id",
      userId: "user_id",
      createdAt: "created_at",
    },
  },
  invitation: {
    modelName: "organization_invitations",
    fields: {
      organizationId: "organization_id",
      expiresAt: "expires_at",
      createdAt: "created_at",
      inviterId: "inviter_id",
    },
  },
} as const;

export const apiKeySchema = {
  apikey: {
    modelName: "api_keys",
    fields: {
      configId: "config_id",
      referenceId: "reference_id",
      refillInterval: "refill_interval",
      refillAmount: "refill_amount",
      lastRefillAt: "last_refill_at",
      rateLimitEnabled: "rate_limit_enabled",
      rateLimitTimeWindow: "rate_limit_time_window",
      rateLimitMax: "rate_limit_max",
      requestCount: "request_count",
      lastRequest: "last_request",
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
} as const;
