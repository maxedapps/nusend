import { describe, expect, it } from "vitest";

import { routes } from "./routes.js";

describe("list contact routes", () => {
  it("encodes list and contact identifiers independently", () => {
    expect(routes.lists.contacts("list/one?x=1")).toBe("/api/lists/list%2Fone%3Fx%3D1/contacts");
    expect(routes.lists.contact("list/one", "contact/two#member")).toBe(
      "/api/lists/list%2Fone/contacts/contact%2Ftwo%23member",
    );
  });
});
