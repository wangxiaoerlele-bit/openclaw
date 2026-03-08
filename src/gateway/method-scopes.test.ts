import { describe, expect, it } from "vitest";
import {
  authorizeOperatorScopesForMethod,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("method scope resolution", () => {
  it("classifies sessions.resolve + config.schema.lookup as read and poll as write", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.resolve")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("config.schema.lookup")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("poll")).toEqual(["operator.write"]);
  });

  it("returns empty scopes for unknown methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("totally.unknown.method")).toEqual([]);
  });
});

describe("operator scope authorization", () => {
  it("allows read methods with operator.read or operator.write", () => {
    expect(authorizeOperatorScopesForMethod("health", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("health", ["operator.write"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("config.schema.lookup", ["operator.read"])).toEqual({
      allowed: true,
    });
  });

  it("requires operator.write for write methods", () => {
    expect(authorizeOperatorScopesForMethod("send", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("requires approvals scope for approval methods", () => {
    expect(authorizeOperatorScopesForMethod("exec.approval.resolve", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
  });

  it("requires admin for unknown methods", () => {
    expect(authorizeOperatorScopesForMethod("unknown.method", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  it("requires admin for secrets methods", () => {
    expect(authorizeOperatorScopesForMethod("secrets.resolve", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(authorizeOperatorScopesForMethod("secrets.reload", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });
});

describe("core gateway method classification", () => {
  it("classifies every exposed core gateway handler method", () => {
    const unclassified = Object.keys(coreGatewayHandlers).filter(
      (method) => !isGatewayMethodClassified(method),
    );
    expect(unclassified).toEqual([]);
  });
});
