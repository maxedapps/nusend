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
  lists: {
    byId: (id: string) => `/api/lists/${encodeURIComponent(id)}`,
    list: "/api/lists",
  },
  mailings: {
    byId: (id: string) => `/api/mailings/${encodeURIComponent(id)}`,
    create: "/api/mailings",
    list: "/api/mailings",
  },
  me: "/api/me",
  operations: {
    deliveries: "/api/operations/deliveries",
    delivery: (id: string) => `/api/operations/deliveries/${encodeURIComponent(id)}`,
    sesEvent: (id: string) => `/api/operations/ses/events/${encodeURIComponent(id)}`,
    sesEvents: "/api/operations/ses/events",
    sesReadiness: "/api/operations/ses/readiness",
    sesSetupGuide: "/api/operations/ses/setup-guide",
    sesSimulatorRun: (id: string) => `/api/operations/ses/simulator-runs/${encodeURIComponent(id)}`,
    sesSimulatorRuns: "/api/operations/ses/simulator-runs",
    sesSummary: "/api/operations/ses/summary",
    summary: "/api/operations/summary",
  },
  suppressions: {
    byId: (id: string) => `/api/suppressions/${encodeURIComponent(id)}`,
    list: "/api/suppressions",
  },
} as const;
