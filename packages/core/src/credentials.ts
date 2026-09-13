/**
 * The shared client secret.
 *
 * One secret unlocks every client tenant, which makes it the highest-consequence value
 * in the product. It goes in the OS keychain and nowhere else — never SQLite, never a
 * JSON file, never a log line. The store keeps only the client ID, scope and grant type.
 */
import type { Store } from "./store.ts";

const SERVICE = "layout-agent";
const ACCOUNT = "bc-client-secret";

export type Credentials = {
	clientId: string;
	clientSecret: string;
	scope: string;
	grantType: string;
};

export interface SecretStore {
	get(): Promise<string | null>;
	set(secret: string): Promise<void>;
	delete(): Promise<void>;
	readonly description: string;
}

async function run(
	cmd: string[],
	stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

/** libsecret / gnome-keyring, via the secret-tool CLI. The Linux default. */
export class SecretToolStore implements SecretStore {
	readonly description = "OS keychain (libsecret)";

	static async available(): Promise<boolean> {
		return process.platform === "linux" && Bun.which("secret-tool") !== null;
	}

	async get(): Promise<string | null> {
		const r = await run([
			"secret-tool",
			"lookup",
			"service",
			SERVICE,
			"account",
			ACCOUNT,
		]);
		if (r.code !== 0 || r.stdout === "") return null;
		return r.stdout.replace(/\n$/, "");
	}

	async set(secret: string): Promise<void> {
		const r = await run(
			[
				"secret-tool",
				"store",
				"--label=Layout Agent — Business Central client secret",
				"service",
				SERVICE,
				"account",
				ACCOUNT,
			],
			secret,
		);
		if (r.code !== 0)
			throw new Error(`secret-tool store failed: ${r.stderr.trim()}`);
	}

	async delete(): Promise<void> {
		await run(["secret-tool", "clear", "service", SERVICE, "account", ACCOUNT]);
	}
}

/** Windows DPAPI, scoped to the current user. The encrypted blob is safe to keep in the data dir. */
export class WindowsDpapiStore implements SecretStore {
	readonly description = "Windows Data Protection API";

	constructor(private readonly path: string) {}

	async get(): Promise<string | null> {
		const file = Bun.file(this.path);
		if (!(await file.exists())) return null;
		const encrypted = await file.text();
		const script =
			"Add-Type -AssemblyName System.Security;" +
			"$c=[Console]::In.ReadToEnd();" +
			"$b=[Convert]::FromBase64String($c);" +
			"$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
			"[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))";
		const result = await run(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
			encrypted,
		);
		if (result.code !== 0)
			throw new Error(
				`Windows could not decrypt the stored client secret: ${result.stderr.trim()}`,
			);
		return result.stdout;
	}

	async set(secret: string): Promise<void> {
		const script =
			"Add-Type -AssemblyName System.Security;" +
			"$s=[Console]::In.ReadToEnd();" +
			"$b=[Text.Encoding]::UTF8.GetBytes($s);" +
			"$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
			"[Console]::Out.Write([Convert]::ToBase64String($p))";
		const result = await run(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
			secret,
		);
		if (result.code !== 0)
			throw new Error(
				`Windows could not encrypt the client secret: ${result.stderr.trim()}`,
			);
		await Bun.write(this.path, result.stdout);
	}

	async delete(): Promise<void> {
		await Bun.file(this.path).delete();
	}
}

/** macOS Keychain. */
export class SecurityStore implements SecretStore {
	readonly description = "macOS Keychain";

	static async available(): Promise<boolean> {
		return (
			process.platform === "darwin" &&
			(await run(["sh", "-c", "command -v security"])).code === 0
		);
	}

	async get(): Promise<string | null> {
		const r = await run([
			"security",
			"find-generic-password",
			"-s",
			SERVICE,
			"-a",
			ACCOUNT,
			"-w",
		]);
		return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
	}

	async set(secret: string): Promise<void> {
		await run([
			"security",
			"delete-generic-password",
			"-s",
			SERVICE,
			"-a",
			ACCOUNT,
		]);
		const r = await run([
			"security",
			"add-generic-password",
			"-s",
			SERVICE,
			"-a",
			ACCOUNT,
			"-w",
			secret,
			"-U",
		]);
		if (r.code !== 0)
			throw new Error(
				`security add-generic-password failed: ${r.stderr.trim()}`,
			);
	}

	async delete(): Promise<void> {
		await run([
			"security",
			"delete-generic-password",
			"-s",
			SERVICE,
			"-a",
			ACCOUNT,
		]);
	}
}

/**
 * Last resort when no keychain exists. Deliberately loud and deliberately awkward: it
 * must never be reached by accident, so it requires an explicit opt-in and says so.
 */
export class FileSecretStore implements SecretStore {
	readonly description = "plaintext file (INSECURE)";

	constructor(private readonly path: string) {}

	async get(): Promise<string | null> {
		const f = Bun.file(this.path);
		return (await f.exists()) ? (await f.text()).trim() : null;
	}

	async set(secret: string): Promise<void> {
		await Bun.write(this.path, secret);
		await run(["chmod", "600", this.path]);
	}

	async delete(): Promise<void> {
		await run(["rm", "-f", this.path]);
	}
}

/**
 * In-memory, for tests and for a dry run.
 *
 * It exists because the alternative bites: `defaultSecretStore` finds the real OS
 * keychain, so a test that saves credentials writes into the developer's actual
 * keyring under the app's own service name and stays there after the run.
 */
export class MemorySecretStore implements SecretStore {
	readonly description = "in-memory (not persisted)";
	#secret: string | null = null;

	async get(): Promise<string | null> {
		return this.#secret;
	}

	async set(secret: string): Promise<void> {
		this.#secret = secret;
	}

	async delete(): Promise<void> {
		this.#secret = null;
	}
}

export async function defaultSecretStore(
	fallbackPath?: string,
): Promise<SecretStore> {
	if (process.platform === "win32" && fallbackPath) {
		return new WindowsDpapiStore(fallbackPath);
	}
	if (await SecurityStore.available()) return new SecurityStore();
	if (await SecretToolStore.available()) return new SecretToolStore();
	if (fallbackPath && process.env.LAYOUT_ALLOW_PLAINTEXT_SECRET === "1") {
		console.warn(
			"[credentials] No OS keychain found. Falling back to a plaintext file because " +
				"LAYOUT_ALLOW_PLAINTEXT_SECRET=1. This secret unlocks every client tenant.",
		);
		return new FileSecretStore(fallbackPath);
	}
	throw new Error(
		"No OS keychain available (looked for `security` on macOS and `secret-tool` on Linux). " +
			"Install libsecret, or set LAYOUT_ALLOW_PLAINTEXT_SECRET=1 to accept an insecure file.",
	);
}

export class CredentialsManager {
	constructor(
		private readonly store: Store,
		private readonly secrets: SecretStore,
	) {}

	get secretStoreDescription(): string {
		return this.secrets.description;
	}

	async save(creds: Credentials): Promise<void> {
		this.store.setCredentialsMeta(creds.clientId, creds.scope, creds.grantType);
		await this.secrets.set(creds.clientSecret);
	}

	/** Write-only from the UI's perspective: it can be set and tested, never read back. */
	async setSecret(secret: string): Promise<void> {
		await this.secrets.set(secret);
	}

	async load(): Promise<Credentials | null> {
		const meta = this.store.credentialsMeta();
		if (!meta) return null;
		const clientSecret = await this.secrets.get();
		if (!clientSecret) return null;
		return { ...meta, clientSecret };
	}

	/** What Settings shows: configured or not, without ever revealing the secret. */
	async status(): Promise<{
		configured: boolean;
		clientId: string | null;
		hasSecret: boolean;
		store: string;
	}> {
		const meta = this.store.credentialsMeta();
		const hasSecret = (await this.secrets.get()) !== null;
		return {
			configured: meta !== null && hasSecret,
			clientId: meta?.clientId ?? null,
			hasSecret,
			store: this.secrets.description,
		};
	}
}
