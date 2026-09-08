/**
 * Settings — shared credentials and per-client connections.
 *
 * The connection test is the important part. Client-credentials against another tenant
 * only works after that tenant has done two separate things: granted admin consent to
 * the app registration, and registered the client ID on BC's own *Microsoft Entra
 * Applications* page with permission sets. Until both are done every call returns 401
 * with an unhelpful body, so this screen names which of the two is missing rather than
 * leaving a user to discover it through failure.
 */

import type { Client, Connection } from "@layout/core";
import { useState } from "react";
import type { Api, CredentialStatus } from "../api.ts";
import {
	Badge,
	Button,
	Card,
	cx,
	Dot,
	Field,
	Input,
	PageHeader,
	SectionLabel,
	Spinner,
} from "../components/ui.tsx";
import { connectionLabel } from "../format.ts";
import { statusLabel, statusTone, toneClass } from "../theme.ts";

export function Settings({
	api,
	credentials,
	clients,
	connections,
	onChanged,
	onAddClient,
	onAddConnection,
}: {
	api: Api;
	credentials: CredentialStatus | null;
	clients: Client[];
	connections: Connection[];
	onChanged: () => void;
	onAddClient: () => void;
	onAddConnection: (client: Client) => void;
}) {
	const [clientId, setClientId] = useState(credentials?.clientId ?? "");
	const [secret, setSecret] = useState("");
	const [scope, setScope] = useState(
		"https://api.businesscentral.dynamics.com/.default",
	);
	const [saving, setSaving] = useState(false);
	const [saveNote, setSaveNote] = useState<string | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	const [results, setResults] = useState<
		Record<string, { status: string; detail: string }>
	>({});

	const save = async () => {
		setSaving(true);
		setSaveNote(null);
		try {
			await api.saveCredentials({
				clientId,
				clientSecret: secret || undefined,
				scope,
				grantType: "client_credentials",
			});
			setSecret("");
			setSaveNote("Saved. The secret went to the OS keychain.");
			onChanged();
		} catch (e) {
			setSaveNote(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	const test = async (id: string) => {
		setTesting(id);
		try {
			const r = await api.testConnection(id);
			setResults((prev) => ({
				...prev,
				[id]: { status: r.status, detail: r.detail },
			}));
			onChanged();
		} catch (e) {
			setResults((prev) => ({
				...prev,
				[id]: { status: "unknown", detail: String(e) },
			}));
		} finally {
			setTesting(null);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="px-4 pt-4 compact:px-6 compact:pt-5">
				<PageHeader
					title="Settings"
					subtitle="Credentials once, then a connection per client tenant"
					actions={
						<Button variant="primary" onClick={onAddClient}>
							<span aria-hidden="true">+</span> Add client
						</Button>
					}
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4 compact:p-6">
				<div className="mx-auto flex max-w-215 flex-col gap-4">
					<Card className="flex flex-col gap-3.5 p-5">
						<div>
							<div className="flex items-center gap-2">
								<h2 className="text-lg font-semibold">Shared credentials</h2>
								{credentials ? (
									<Badge tone={credentials.configured ? "ok" : "warn"}>
										<span
											className="size-1.5 rounded-full bg-current"
											aria-hidden="true"
										/>
										{credentials.configured ? "configured" : "incomplete"}
									</Badge>
								) : null}
							</div>
							<p className="mt-1 text-base leading-5 text-dim">
								One multi-tenant Entra app registration serves every client. The
								same client ID and secret, a different tenant ID per connection.
							</p>
						</div>

						<div className="flex max-w-155 flex-col gap-3">
							<Field label="Client ID">
								<Input
									value={clientId}
									onChange={(e) => setClientId(e.target.value)}
									placeholder="00000000-0000-0000-0000-000000000000"
									autoComplete="off"
									spellCheck={false}
								/>
							</Field>
							<Field
								label={
									credentials?.hasSecret
										? "Client secret (stored — type to replace)"
										: "Client secret"
								}
								hint="This one secret unlocks every client tenant. It is never written to the database and never read back into this screen."
							>
								<Input
									type="password"
									value={secret}
									onChange={(e) => setSecret(e.target.value)}
									autoComplete="off"
									placeholder={
										credentials?.hasSecret
											? "•••••••• stored in the keychain"
											: "paste the secret"
									}
								/>
							</Field>
							<Field label="Scope">
								<Input
									value={scope}
									onChange={(e) => setScope(e.target.value)}
									spellCheck={false}
								/>
							</Field>
							<div className="flex items-center gap-2.5">
								<Button variant="primary" onClick={save} disabled={saving}>
									{saving ? (
										<>
											<Spinner /> Saving…
										</>
									) : (
										"Save credentials"
									)}
								</Button>
								<span className="flex-1" />
								<span className="truncate font-mono text-xs text-faint">
									{credentials?.store ?? ""}
								</span>
							</div>
							{saveNote ? (
								<p className="text-base text-dim">{saveNote}</p>
							) : null}
						</div>
					</Card>

					<div className="pt-1 pl-0.5">
						<SectionLabel>Clients</SectionLabel>
					</div>

					{clients.length === 0 ? (
						<Card className="flex flex-col gap-3 p-5">
							<h2 className="text-lg font-semibold">No clients yet</h2>
							<p className="text-base leading-5 text-dim">
								A client is a customer organisation; a connection is one
								reachable Business Central target for them — tenant, environment
								and company.
							</p>
							<div>
								<Button variant="primary" onClick={onAddClient}>
									<span aria-hidden="true">+</span> Add client
								</Button>
							</div>
						</Card>
					) : null}

					{clients.map((c) => {
						const rows = connections.filter((x) => x.clientId === c.id);
						return (
							<Card key={c.id} className="overflow-hidden">
								<div
									className={cx(
										"flex items-center gap-2.5 px-4 py-3.5",
										rows.length > 0 && "border-b border-subtle",
									)}
								>
									<span className="truncate text-base font-semibold">
										{c.name}
									</span>
									<span className="shrink-0 text-sm text-faint">
										{rows.length} connection{rows.length === 1 ? "" : "s"}
									</span>
									<span className="flex-1" />
									<Button size="sm" onClick={() => onAddConnection(c)}>
										Add connection
									</Button>
								</div>

								{rows.length === 0 ? (
									<p className="px-4 pb-3.5 text-sm text-faint">
										No connection yet, so this client's layouts cannot render.
									</p>
								) : null}

								{rows.map((conn, i) => {
									const result = results[conn.id];
									const status = result?.status ?? conn.lastStatus;
									return (
										<div
											key={conn.id}
											className={cx(
												"flex flex-col gap-2 px-4 py-3",
												i > 0 && "border-t border-subtle",
											)}
										>
											<div className="flex flex-wrap items-center gap-2.5">
												<Dot tone={statusTone(status)} />
												<div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
													<span className="truncate text-base font-medium">
														{connectionLabel(conn)}
													</span>
													<span className="truncate font-mono text-xs text-faint">
														{conn.tenantId}
													</span>
												</div>
												<Badge tone={statusTone(status)}>
													{statusLabel(status)}
												</Badge>
												<Button
													size="sm"
													onClick={() => test(conn.id)}
													disabled={testing === conn.id}
												>
													{testing === conn.id ? (
														<>
															<Spinner /> Testing…
														</>
													) : (
														"Test connection"
													)}
												</Button>
											</div>
											{result?.detail ? (
												<p
													className={cx(
														"rounded-md border p-2.5 text-xs leading-relaxed",
														toneClass(statusTone(status)),
													)}
												>
													{result.detail}
												</p>
											) : null}
										</div>
									);
								})}
							</Card>
						);
					})}

					<Card className="flex flex-col gap-3 p-5">
						<h2 className="text-lg font-semibold">
							Onboarding a new client tenant
						</h2>
						<p className="text-base leading-5 text-dim">
							Both steps happen in the customer's tenant, and both are required.
						</p>
						<ol className="flex flex-col gap-2.5">
							{[
								"Grant admin consent to this multi-tenant app registration.",
								"Register the client ID on Business Central's Microsoft Entra Applications page, set the state to Enabled, and grant permission sets that include the layout preview API.",
							].map((s, i) => (
								<li key={s} className="flex items-start gap-2.5">
									<span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-strong bg-raised text-xs text-dim">
										{i + 1}
									</span>
									<span className="min-w-0 flex-1 text-base leading-5 text-dim">
										{s}
									</span>
								</li>
							))}
						</ol>
					</Card>
				</div>
			</div>
		</div>
	);
}
