import { describe, expect, it } from "vitest";
import { databaseConfig } from "./pg-database.js";

describe("database transport configuration", () => {
  it("requires verified TLS for Supabase and other remote hosts", () => {
    expect(databaseConfig("postgresql://user:password@db.example.supabase.co/postgres").ssl)
      .toEqual({ rejectUnauthorized: true });
  });
  it("allows plaintext only for explicit loopback development", () => {
    expect(databaseConfig("postgresql://user:password@127.0.0.1:5432/postgres").ssl).toBe(false);
  });
  it.each([
    "bad", "https://user:secret@db.example/database", "postgresql://db.example/database",
    "postgresql://user:secret@db.example/", "postgresql://user:secret@db.example/db?sslmode=disable",
    "postgresql://user:secret@db.example/db?sslrootcert=bad", "postgresql://user:secret@db.example/db#other",
  ])("rejects invalid or overriding configuration without exposing credentials", (value) => {
    expect(() => databaseConfig(value)).toThrow(/^DATABASE_CONFIGURATION$/);
  });
});
