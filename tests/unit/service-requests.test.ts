import { describe, expect, it } from "vitest";
import { classifyServiceRequest } from "@/lib/integrations/service-requests";

describe("add-a-service classification", () => {
  it("recognises existing connectors", () => {
    expect(classifyServiceRequest("Gmail", "read my inbox")).toMatchObject({ status: "existing_connector", matchedProvider: "google" });
    expect(classifyServiceRequest("GoHighLevel", "contacts")).toMatchObject({ status: "existing_connector", matchedProvider: "highlevel" });
    expect(classifyServiceRequest("Instagram", "insights")).toMatchObject({ status: "existing_connector", matchedProvider: "meta" });
  });
  it("maps known official APIs to connector_can_be_prepared", () => {
    expect(classifyServiceRequest("QuickBooks", "read invoices")).toMatchObject({ status: "connector_can_be_prepared" });
    expect(classifyServiceRequest("HubSpot", "deals")).toMatchObject({ status: "connector_can_be_prepared" });
  });
  it("refuses scraping / password sharing", () => {
    expect(classifyServiceRequest("Some portal", "log in as me with my password and scrape the dashboard")).toMatchObject({ status: "unsupported" });
  });
  it("falls back to manual investigation", () => {
    expect(classifyServiceRequest("ObscureVendorX", "sync widgets")).toMatchObject({ status: "manual_investigation_required" });
  });
});
