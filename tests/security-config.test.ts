import { readFile, readdir } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url);

describe("Tauri security configuration", () => {
  it("declares every directly imported desktop runtime dependency", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("apps/desktop/package.json", root), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.zod).toBeDefined();
  });

  it("uses a restrictive CSP without unsafe script evaluation", async () => {
    const config = JSON.parse(
      await readFile(
        new URL("apps/desktop/src-tauri/tauri.conf.json", root),
        "utf8",
      ),
    );
    const csp = config.app.security.csp as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*");
  });

  it("grants only explicit core and deep-link permissions, never shell or filesystem", async () => {
    const capability = JSON.parse(
      await readFile(
        new URL("apps/desktop/src-tauri/capabilities/main.json", root),
        "utf8",
      ),
    );
    const permissions = JSON.stringify(capability.permissions);
    expect(capability.windows).toEqual(["main"]);
    expect(permissions).not.toMatch(/shell|fs:|filesystem/i);
    expect(capability.remote).toBeUndefined();
  });

  it("provides enforceable dependency and secret scanning commands", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("package.json", root), "utf8"),
    );
    expect(manifest.scripts["security:deps:js"]).toContain(
      "--audit-level=high",
    );
    expect(manifest.scripts["security:deps:rust"]).toContain("cargo audit");
    expect(manifest.scripts["security:secrets"]).toContain("gitleaks");
  });

  it("keeps local credentials and build outputs out of version control", async () => {
    const ignore = await readFile(new URL(".gitignore", root), "utf8");
    expect(ignore).toMatch(/^\.env\*$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
    expect(ignore).toMatch(/^target\/$/m);
  });

  it("keeps JavaScript native-vault calls aligned with implemented Rust commands", async () => {
    const vault = await readFile(
      new URL("apps/desktop/src/auth/native-session-vault.ts", root),
      "utf8",
    );
    const rust = await readFile(
      new URL("apps/desktop/src-tauri/src/lib.rs", root),
      "utf8",
    );
    const commands = [
      "read_session_secret",
      "write_session_secret",
      "clear_session_secret",
    ];
    for (const command of commands) {
      expect(vault).toContain(`"${command}"`);
      expect(rust).toContain(`fn ${command}(`);
    }
    expect(vault).not.toMatch(
      /load_session_handle|save_session_handle|remove_session_handle/,
    );
  });

  it("forwards Windows deep links to one instance and handles startup batches", async () => {
    const cargo = await readFile(
      new URL("apps/desktop/src-tauri/Cargo.toml", root),
      "utf8",
    );
    const rust = await readFile(
      new URL("apps/desktop/src-tauri/src/lib.rs", root),
      "utf8",
    );
    const main = await readFile(
      new URL("apps/desktop/src/main.tsx", root),
      "utf8",
    );
    expect(cargo).toMatch(
      /tauri-plugin-single-instance\s*=\s*\{[^}]*features\s*=\s*\["deep-link"\]/,
    );
    expect(rust.indexOf("tauri_plugin_single_instance::init")).toBeLessThan(
      rust.indexOf("tauri_plugin_deep_link::init"),
    );
    expect(main).toMatch(/getCurrent\(\)/);
    expect(main).toContain("deliverAuthCallbacks");
    expect(main).not.toMatch(/candidates\[0\]/);
  });

  it("locks a resolvable, aligned Tauri deep-link plugin graph", async () => {
    const cargoSource = await readFile(
      new URL("apps/desktop/src-tauri/Cargo.toml", root),
      "utf8",
    );
    const cargo = parseToml(cargoSource) as {
      "build-dependencies": Record<
        string,
        string | Readonly<{ version: string; features?: readonly string[] }>
      >;
      dependencies: Record<
        string,
        string | Readonly<{ version: string; features?: readonly string[] }>
      >;
    };
    expect(cargo["build-dependencies"]["tauri-build"]).toEqual({
      version: "=2.6.3",
      features: [],
    });
    expect(cargo.dependencies.tauri).toEqual({
      version: "=2.11.1",
      features: [],
    });
    expect(cargo.dependencies["tauri-plugin-deep-link"]).toBe("=2.4.9");
    expect(cargo.dependencies["tauri-plugin-opener"]).toBe("=2.5.4");
    expect(cargo.dependencies["tauri-plugin-single-instance"]).toEqual({
      version: "=2.4.3",
      features: ["deep-link"],
    });

    const lock = await readFile(
      new URL("apps/desktop/src-tauri/Cargo.lock", root),
      "utf8",
    );
    expect(lock).toMatch(
      /name = "tauri-plugin-deep-link"\nversion = "2\.4\.9"/u,
    );
    expect(lock).toMatch(
      /name = "tauri-plugin-single-instance"\nversion = "2\.4\.3"/u,
    );
  });

  it("loads desktop build-time environment values from the repository root", async () => {
    const vite = await readFile(
      new URL("apps/desktop/vite.config.ts", root),
      "utf8",
    );
    const runbook = await readFile(
      new URL("docs/security/auth-risk-gate.md", root),
      "utf8",
    );
    expect(vite).toMatch(/envDir:\s*"\.\.\/\.\."/);
    expect(runbook).toMatch(/repository root.*\.env\.local/is);
    expect(runbook).toMatch(/build-time|embedded/i);
    expect(runbook).toMatch(/rebuild.*reinstall/is);
  });

  it("wires private data requests through generation-bound token leases", async () => {
    const main = await readFile(
      new URL("apps/desktop/src/main.tsx", root),
      "utf8",
    );
    expect(main).toContain("runtime.accessTokenLease()");
    expect(main).not.toContain("accessToken: () => runtime.accessToken()");
  });
});

describe("current Clerk third-party auth boundary", () => {
  it("keeps the exact hosted issuer in a repeatable environment-only admin operation", async () => {
    const issuer = "https://steady-ladybug-22.clerk.accounts.dev";
    const operation = await readFile(
      new URL(
        "supabase/admin/subtrack-dev/set-clerk-identity-authority.sql",
        root,
      ),
      "utf8",
    );
    const manifest = JSON.parse(
      await readFile(new URL("package.json", root), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(operation).toContain("subtrack-dev (qjsyhvclllikkopjfqtc)");
    expect(operation).toContain("lock table private.clerk_identity_authority");
    expect(operation).toContain("on conflict (singleton) do update");
    expect(operation.match(new RegExp(issuer, "g"))).toHaveLength(2);
    expect(manifest.scripts["admin:clerk-authority:subtrack-dev"]).toBe(
      "supabase db query --linked --file supabase/admin/subtrack-dev/set-clerk-identity-authority.sql",
    );

    const migrationNames = (
      await readdir(new URL("supabase/migrations", root))
    ).filter((name) => name.endsWith(".sql"));
    const migrations = (
      await Promise.all(
        migrationNames.map((name) =>
          readFile(new URL(`supabase/migrations/${name}`, root), "utf8"),
        ),
      )
    ).join("\n");
    expect(migrations).not.toContain(issuer);
  });

  it("contains no production dependency on the deprecated JWT-template integration", async () => {
    const files = [
      "supabase/functions/.env.example",
      "supabase/functions/auth-broker/config.ts",
      "supabase/functions/auth-broker/index.ts",
      "supabase/functions/auth-broker/clerk-oauth-provider.ts",
      "docs/security/auth-broker.md",
      "docs/security/auth-risk-gate.md",
    ];
    const productionBoundary = (
      await Promise.all(
        files.map((path) => readFile(new URL(path, root), "utf8")),
      )
    ).join("\n");
    expect(productionBoundary).not.toMatch(
      /CLERK_JWT_TEMPLATE|jwtTemplate|expectedAudience|session-token template|tokens\/supabase|wrong audience/i,
    );
  });

  it("configures Clerk as current third-party auth without a legacy audience", async () => {
    const source = await readFile(
      new URL("supabase/config.toml", root),
      "utf8",
    );
    const config = parseToml(source) as {
      api: { schemas: string[]; max_rows: number };
      auth: {
        site_url: string;
        additional_redirect_urls: string[];
        enable_signup: boolean;
        enable_anonymous_sign_ins: boolean;
        email: {
          enable_signup: boolean;
          enable_confirmations: boolean;
          max_frequency: string;
          otp_length: number;
        };
        sms: { enable_signup: boolean };
        mfa: {
          totp: { enroll_enabled: boolean; verify_enabled: boolean };
        };
        third_party: { clerk: { enabled: boolean; domain: string } };
      };
    };
    expect(config.api.schemas).toEqual(["public", "graphql_public"]);
    expect(config.api.max_rows).toBe(1000);
    const behavioralCoverageTest = await readFile(
      new URL("supabase/tests/cloud_data_plane_behavioral_coverage.sql", root),
      "utf8",
    );
    const exposedSchemaEvidence = behavioralCoverageTest.match(
      /insert into pg_temp\.exposed_schemas\(schema_name\)\s+values([\s\S]*?);/i,
    )?.[1];
    expect(exposedSchemaEvidence).toBeDefined();
    const evidencedSchemas = [
      ...(exposedSchemaEvidence ?? "").matchAll(/\('([^']+)'\)/g),
    ].flatMap((match) => (typeof match[1] === "string" ? [match[1]] : []));
    expect(evidencedSchemas.sort()).toEqual([...config.api.schemas].sort());
    expect(config.auth).toMatchObject({
      site_url: "http://localhost:3000",
      additional_redirect_urls: [],
      enable_signup: false,
      enable_anonymous_sign_ins: false,
      email: {
        enable_signup: false,
        enable_confirmations: true,
        max_frequency: "1m",
        otp_length: 8,
      },
      sms: { enable_signup: false },
      mfa: {
        totp: { enroll_enabled: true, verify_enabled: true },
      },
      third_party: {
        clerk: {
          enabled: true,
          domain: "env(CLERK_FRONTEND_API_DOMAIN)",
        },
      },
    });
    expect(source).not.toMatch(/jwt_template|audience/i);
  });
});

describe("cloud data-plane security boundary", () => {
  it("runs the corrected-renewal migration chain as its own security CI gate", async () => {
    const workflow = await readFile(
      new URL(".github/workflows/security.yml", root),
      "utf8",
    );

    expect(workflow).toMatch(
      /\n {2}renewal-migration-chain:\n {4}runs-on: ubuntu-latest\n/,
    );
    expect(workflow.match(/npm run test:migration-chain/g)).toHaveLength(1);
    expect(workflow).not.toMatch(
      /test:migration-chain[\s\S]{0,80}continue-on-error:\s*true/,
    );
  });

  it("keeps behavioral coverage evidence test-owned", async () => {
    const migrationNames = (
      await readdir(new URL("supabase/migrations", root))
    ).filter((name) => name.endsWith(".sql"));
    const migrations = (
      await Promise.all(
        migrationNames.map((name) =>
          readFile(new URL(`supabase/migrations/${name}`, root), "utf8"),
        ),
      )
    ).join("\n");
    const behavioralCoverageTest = await readFile(
      new URL("supabase/tests/cloud_data_plane_behavioral_coverage.sql", root),
      "utf8",
    );

    expect(migrations).toContain(
      "drop table if exists private.data_plane_behavioral_test_registry",
    );
    expect(behavioralCoverageTest).not.toContain(
      "private.data_plane_behavioral_test_registry",
    );
    expect(behavioralCoverageTest).toContain("pg_temp.behaviorally_exercised");
    expect(behavioralCoverageTest).toContain("operation_name name not null");
    expect(behavioralCoverageTest).toContain(
      "primary key (role_name, table_schema, table_name, operation_name)",
    );
    expect(behavioralCoverageTest).toContain(
      "effective_client_writable_operations",
    );
    expect(behavioralCoverageTest).toMatch(
      /with (?:inserted|changed|removed) as \([\s\S]*?insert into pg_temp\.behaviorally_exercised/i,
    );
    expect(behavioralCoverageTest).not.toMatch(
      /insert into pg_temp\.behaviorally_exercised\([^;]+?\)\s*values/i,
    );
    expect(behavioralCoverageTest).toContain(
      "renewal DELETE is denied even for the authenticated owner",
    );
    expect(migrations).toContain("alter column state set default 'expected'");
    expect(migrations).toContain(
      "create policy renewal_events_insert_expected",
    );
    expect(migrations).toContain("create policy renewal_events_delete_denied");
    expect(migrations).toContain(
      "revoke delete on table public.renewal_events from authenticated",
    );
  });

  it("reconciles old-helper PAN rows without exposing their values", async () => {
    const migrationNames = (
      await readdir(new URL("supabase/migrations", root))
    ).filter((name) =>
      name.endsWith("_pan_constraint_upgrade_reconciliation.sql"),
    );
    expect(migrationNames).toHaveLength(1);
    const migration = await readFile(
      new URL(`supabase/migrations/${migrationNames[0]}`, root),
      "utf8",
    );
    const chain = await readFile(
      new URL("tests/run-renewal-migration-chain.sh", root),
      "utf8",
    );

    expect(migration).toContain("update public.subscriptions");
    expect(migration).toMatch(
      /payment_label\s*=\s*case[\s\S]*?private\.contains_payment_card_number\(payment_label\)[\s\S]*?then null[\s\S]*?else payment_label/i,
    );
    expect(migration).toMatch(
      /notes\s*=\s*case[\s\S]*?private\.contains_payment_card_number\(notes\)[\s\S]*?then null[\s\S]*?else notes/i,
    );
    expect(migration).toContain(
      "drop constraint subscriptions_payment_label_pan_free",
    );
    expect(migration).toContain("drop constraint subscriptions_notes_pan_free");
    expect(migration).toContain(
      "add constraint subscriptions_payment_label_pan_free",
    );
    expect(migration).toContain("add constraint subscriptions_notes_pan_free");
    expect(migration).toContain("not valid");
    expect(migration).toContain(
      "validate constraint subscriptions_payment_label_pan_free",
    );
    expect(migration).toContain(
      "validate constraint subscriptions_notes_pan_free",
    );
    expect(migration).not.toMatch(/\breturning\b|raise\s+(?:notice|log)/i);
    expect(migration).not.toContain("4111");
    expect(chain).toContain(
      "20260805182905_pan_constraint_upgrade_reconciliation.sql",
    );
    expect(chain).toContain("U&'4111\\00A01111\\00A01111\\00A01111'");
  });

  it("documents the data-plane helpers with their actual execution modes", async () => {
    const runbook = await readFile(
      new URL("docs/security/cloud-data-plane.md", root),
      "utf8",
    );

    expect(runbook).toContain(
      "`private.current_clerk_subject()` is the narrowly scoped `SECURITY DEFINER`",
    );
    expect(runbook).toContain(
      "`private.enforce_owned_row()` remains `SECURITY INVOKER`",
    );
    expect(runbook).not.toContain("functions are private, security-invoker");
  });

  it("pins the authoritative hosted PostgreSQL major and guards migration-chain drift", async () => {
    const config = parseToml(
      await readFile(new URL("supabase/config.toml", root), "utf8"),
    ) as { db: { major_version: number } };
    const chain = await readFile(
      new URL("tests/run-renewal-migration-chain.sh", root),
      "utf8",
    );

    expect(config.db.major_version).toBe(17);
    expect(chain).toContain(
      'postgres_image="public.ecr.aws/supabase/postgres:17.',
    );
    expect(chain).toContain("configured_major=$(");
    expect(chain).toContain("runtime_major=$(");
    expect(chain).toContain("Postgres major drift");
  });

  it("derives ownership only from standard verified Clerk claims", async () => {
    const migration = await readFile(
      new URL("supabase/migrations/20260804220000_cloud_data_plane.sql", root),
      "utf8",
    );
    expect(migration).toContain("claims->>'role' = 'authenticated'");
    expect(migration).toContain("claims->>'sub'");
    expect(migration).toContain("claims->>'exp'");
    expect(migration).not.toMatch(/user_metadata|auth\.role\s*\(/i);
  });

  it("enforces explicit CRUD RLS and immutable ownership for every exposed table", async () => {
    const migration = await readFile(
      new URL("supabase/migrations/20260804220000_cloud_data_plane.sql", root),
      "utf8",
    );
    const tables = [
      "user_preferences",
      "subscriptions",
      "renewal_events",
      "reminder_overrides",
      "reminder_deliveries",
      "fx_rates",
      "security_audit_events",
    ];
    for (const table of tables) {
      expect(migration).toContain(
        `alter table public.${table} force row level security`,
      );
      expect(migration).toMatch(
        new RegExp(
          `create policy ${table}_[\\w_]+ on public\\.${table} for select`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `create policy ${table}_[\\w_]+ on public\\.${table} for insert`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `create policy ${table}_[\\w_]+ on public\\.${table} for update[\\s\\S]*?using \\([\\s\\S]*?with check \\(`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `create policy ${table}_[\\w_]+ on public\\.${table} for delete`,
          "i",
        ),
      );
    }
    expect(migration).toContain("owner_user_id is immutable");
  });

  it("never exposes a server credential through desktop environment configuration", async () => {
    const environment = await readFile(new URL(".env.example", root), "utf8");
    expect(environment).toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
    expect(environment).not.toMatch(/VITE_.*(?:SERVICE_ROLE|SECRET)/i);
  });

  it("keeps the integrity fixup fail-closed and free of legacy Clerk claims", async () => {
    const migration = await readFile(
      new URL(
        "supabase/migrations/20260805044822_security_integrity_fixup.sql",
        root,
      ),
      "utf8",
    );
    expect(migration).toContain("private.clerk_identity_authority");
    expect(migration).toContain("claims->>'iss' = authority.issuer");
    expect(migration).toContain("9007199254740991");
    expect(migration).toContain("original_currency_code");
    expect(migration).not.toMatch(
      /user_metadata|auth\.role\s*\(|audience|jwt_template/i,
    );
  });
});
