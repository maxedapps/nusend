export const routes = {
  apiKeys: {
    byId: (id: string) => `/api/api-keys/${encodeURIComponent(id)}`,
    list: "/api/api-keys",
    rotate: (id: string) => `/api/api-keys/${encodeURIComponent(id)}/rotate`,
  },
  contacts: {
    byId: (id: string) => `/api/contacts/${encodeURIComponent(id)}`,
    list: "/api/contacts",
  },
  deviceAuthorizations: {
    start: "/api/device-authorizations",
    token: "/api/device-authorizations/token",
  },
  lists: "/api/lists",
  mailings: {
    byId: (id: string) => `/api/mailings/${encodeURIComponent(id)}`,
    create: "/api/mailings",
    list: "/api/mailings",
  },
  me: "/api/me",
  operations: {
    deliveries: "/api/operations/deliveries",
    delivery: (id: string) => `/api/operations/deliveries/${encodeURIComponent(id)}`,
    sesEvents: "/api/operations/ses/events",
    summary: "/api/operations/summary",
  },
  suppressions: "/api/suppressions",
} as const;
