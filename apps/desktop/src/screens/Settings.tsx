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

import { type Client, type Connection, connectionLabel } from "@layout/core";
import { useState } from "react";
import type { Api, CredentialStatus } from "../api.ts";
import {
	Badge,
	Button,
	Card,
	Col,
	Field,
	Row,
	Scroll,
	Text,
} from "../components/ui.tsx";
import { statusColor, statusLabel, t } from "../theme.ts";

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
		<Col gap={0} grow={1} style={{ minHeight: 0 }}>
			<Row
				style={{
					paddingLeft: 20,
					paddingRight: 20,
					paddingTop: 16,
					paddingBottom: 14,
					borderBottomWidth: 1,
					borderColor: t.border,
				}}
			>
				<Text size={18} weight={600}>
					Settings
				</Text>
				<div style={{ flexGrow: 1 }} />
				<Button label="Add client" variant="primary" onClick={onAddClient} />
			</Row>

			<Scroll style={{ padding: 20, gap: 18 }}>
				<Card>
					<Text size={14} weight={600}>
						Shared credentials
					</Text>
					<Text color={t.textDim} size={12}>
						One multi-tenant Entra app registration serves every client. The
						same client ID and secret, a different tenant ID per connection.
					</Text>

					<Col gap={10} style={{ paddingTop: 6, maxWidth: 560 }}>
						<Field
							label="Client ID"
							value={clientId}
							onChange={setClientId}
							placeholder="00000000-0000-0000-0000-000000000000"
						/>
						<Field
							label={
								credentials?.hasSecret
									? "Client secret (stored — type to replace)"
									: "Client secret"
							}
							value={secret}
							onChange={setSecret}
							secret
							placeholder={
								credentials?.hasSecret
									? "•••••••• stored in the keychain"
									: "paste the secret"
							}
						/>
						<Field label="Scope" value={scope} onChange={setScope} />
						<Row gap={10}>
							<Button
								label={saving ? "Saving…" : "Save"}
								variant="primary"
								onClick={save}
								disabled={saving}
							/>
							{credentials ? (
								<Badge
									label={credentials.configured ? "configured" : "incomplete"}
									color={credentials.configured ? t.ok : t.warn}
								/>
							) : null}
							<Text color={t.textFaint} size={11.5}>
								{credentials?.store ?? ""}
							</Text>
						</Row>
						{saveNote ? (
							<Text color={t.textDim} size={12}>
								{saveNote}
							</Text>
						) : null}
						<Text color={t.textFaint} size={11.5}>
							This one secret unlocks every client tenant. It is never written
							to the database and never read back into this screen.
						</Text>
					</Col>
				</Card>

				{clients.length === 0 ? (
					<Card>
						<Text size={14} weight={600}>
							No clients yet
						</Text>
						<Text color={t.textDim} size={12}>
							A client is a customer organisation; a connection is one reachable
							Business Central target for them — tenant, environment and
							company.
						</Text>
						<Row>
							<Button
								label="Add client"
								variant="primary"
								onClick={onAddClient}
							/>
						</Row>
					</Card>
				) : null}

				{clients.map((c) => {
					const rows = connections.filter((x) => x.clientId === c.id);
					return (
						<Card key={c.id}>
							<Row>
								<Text size={14} weight={600}>
									{c.name}
								</Text>
								<div style={{ flexGrow: 1 }} />
								<Text color={t.textFaint} size={12}>
									{`${rows.length} connection${rows.length === 1 ? "" : "s"}`}
								</Text>
								<Button
									label="Add connection"
									onClick={() => onAddConnection(c)}
								/>
							</Row>

							{rows.length === 0 ? (
								<Text color={t.textFaint} size={11.5}>
									No connection yet, so this client's layouts cannot render.
								</Text>
							) : null}

							{rows.map((conn) => {
								const result = results[conn.id];
								const status = result?.status ?? conn.lastStatus;
								return (
									<Col key={conn.id} gap={6} style={{ paddingTop: 8 }}>
										<Row gap={10}>
											<Col gap={2} style={{ width: 300, minWidth: 0 }}>
												<Text size={13} clamp={1}>
													{connectionLabel(conn)}
												</Text>
												<Text color={t.textFaint} size={11} mono clamp={1}>
													{conn.tenantId}
												</Text>
											</Col>
											<Badge
												label={statusLabel(status)}
												color={statusColor(status)}
											/>
											<div style={{ flexGrow: 1 }} />
											<Button
												label={
													testing === conn.id ? "Testing…" : "Test connection"
												}
												onClick={() => test(conn.id)}
												disabled={testing === conn.id}
											/>
										</Row>
										{result?.detail ? (
											<div
												style={{
													display: "flex",
													padding: 9,
													borderRadius: 6,
													backgroundColor: t.bg,
													borderWidth: 1,
													borderColor: t.border,
												}}
											>
												<text
													style={{
														color: t.textDim,
														fontSize: 11.5,
														fontFamily: t.mono,
													}}
												>
													{result.detail}
												</text>
											</div>
										) : null}
									</Col>
								);
							})}
						</Card>
					);
				})}

				<Card>
					<Text size={14} weight={600}>
						Onboarding a new client tenant
					</Text>
					<Text color={t.textDim} size={12}>
						Both steps happen in the customer's tenant, and both are required:
					</Text>
					<Col gap={4} style={{ paddingLeft: 4 }}>
						<Text color={t.textDim} size={12}>
							1. Grant admin consent to this multi-tenant app registration.
						</Text>
						<Text color={t.textDim} size={12}>
							2. Register the client ID on Business Central's Microsoft Entra
							Applications page, set the state to Enabled, and grant permission
							sets that include the layout preview API.
						</Text>
					</Col>
					<Text color={t.textFaint} size={11.5}>
						Test connection distinguishes the two: "not consented" means step 1,
						"not registered in BC" means step 2.
					</Text>
				</Card>
			</Scroll>
		</Col>
	);
}
