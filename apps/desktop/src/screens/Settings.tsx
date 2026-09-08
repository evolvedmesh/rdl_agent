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
	Dot,
	Field,
	gutter,
	Measure,
	PageHeader,
	Row,
	Scroll,
	SectionLabel,
	Spacer,
	Text,
	useBreakpoint,
	Well,
} from "../components/ui.tsx";
import {
	font,
	radius,
	statusColor,
	statusLabel,
	statusTone,
	t,
} from "../theme.ts";

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
	const b = useBreakpoint();
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
			<PageHeader
				title="Settings"
				subtitle="Credentials once, then a connection per client tenant"
				compact={b.compact}
				actions={
					<Button
						label="Add client"
						icon="+"
						variant="primary"
						onClick={onAddClient}
					/>
				}
			/>

			<Scroll style={{ padding: gutter(b) }}>
				<Measure max={860} gap={16}>
					<Card padding={20} gap={14}>
						<Col gap={4}>
							<Row gap={8}>
								<Text size={font.lg} weight={600}>
									Shared credentials
								</Text>
								{credentials ? (
									<Badge
										label={credentials.configured ? "configured" : "incomplete"}
										tone={credentials.configured ? "ok" : "warn"}
										dot
									/>
								) : null}
							</Row>
							<Text color={t.textDim} size={font.base} lineHeight={19}>
								One multi-tenant Entra app registration serves every client. The
								same client ID and secret, a different tenant ID per connection.
							</Text>
						</Col>

						<Col gap={12} style={{ maxWidth: 620 }}>
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
								hint="This one secret unlocks every client tenant. It is never written to the database and never read back into this screen."
							/>
							<Field label="Scope" value={scope} onChange={setScope} />
							<Row gap={10}>
								<Button
									label={saving ? "Saving…" : "Save credentials"}
									variant="primary"
									onClick={save}
									disabled={saving}
								/>
								<Spacer />
								<Text color={t.textFaint} size={font.xs} mono clamp={1}>
									{credentials?.store ?? ""}
								</Text>
							</Row>
							{saveNote ? (
								<Text color={t.textDim} size={font.base}>
									{saveNote}
								</Text>
							) : null}
						</Col>
					</Card>

					<SectionLabel style={{ paddingLeft: 2, paddingTop: 4 }}>
						CLIENTS
					</SectionLabel>

					{clients.length === 0 ? (
						<Card padding={20} gap={12}>
							<Text size={font.lg} weight={600}>
								No clients yet
							</Text>
							<Text color={t.textDim} size={font.base} lineHeight={19}>
								A client is a customer organisation; a connection is one
								reachable Business Central target for them — tenant, environment
								and company.
							</Text>
							<Row>
								<Button
									label="Add client"
									icon="+"
									variant="primary"
									onClick={onAddClient}
								/>
							</Row>
						</Card>
					) : null}

					{clients.map((c) => {
						const rows = connections.filter((x) => x.clientId === c.id);
						return (
							<Card key={c.id} padding={0} gap={0}>
								<Row
									gap={10}
									style={{
										paddingLeft: 18,
										paddingRight: 14,
										paddingTop: 14,
										paddingBottom: 14,
										borderBottomWidth: rows.length > 0 ? 1 : 0,
										borderColor: t.border,
									}}
								>
									<Text size={font.md} weight={600} clamp={1}>
										{c.name}
									</Text>
									<Text color={t.textFaint} size={font.sm}>
										{`${rows.length} connection${rows.length === 1 ? "" : "s"}`}
									</Text>
									<Spacer />
									<Button
										label="Add connection"
										size="sm"
										onClick={() => onAddConnection(c)}
									/>
								</Row>

								{rows.length === 0 ? (
									<div
										style={{
											display: "flex",
											paddingLeft: 18,
											paddingRight: 18,
											paddingBottom: 14,
										}}
									>
										<text style={{ color: t.textFaint, fontSize: font.sm }}>
											No connection yet, so this client's layouts cannot render.
										</text>
									</div>
								) : null}

								{rows.map((conn, i) => {
									const result = results[conn.id];
									const status = result?.status ?? conn.lastStatus;
									return (
										<Col
											key={conn.id}
											gap={8}
											style={{
												paddingLeft: 18,
												paddingRight: 14,
												paddingTop: 12,
												paddingBottom: 12,
												borderTopWidth: i === 0 ? 0 : 1,
												borderColor: t.border,
											}}
										>
											<Row gap={10} wrap={b.narrow}>
												<Dot color={statusColor(status)} />
												<Col
													gap={2}
													style={{ flexGrow: 1, flexBasis: 240, minWidth: 0 }}
												>
													<Text size={font.base} weight={500} clamp={1}>
														{connectionLabel(conn)}
													</Text>
													<Text
														color={t.textFaint}
														size={font.xs}
														mono
														clamp={1}
													>
														{conn.tenantId}
													</Text>
												</Col>
												<Badge
													label={statusLabel(status)}
													tone={statusTone(status)}
												/>
												<Button
													label={
														testing === conn.id ? "Testing…" : "Test connection"
													}
													size="sm"
													onClick={() => test(conn.id)}
													disabled={testing === conn.id}
												/>
											</Row>
											{result?.detail ? (
												<Well tone={statusTone(status)}>{result.detail}</Well>
											) : null}
										</Col>
									);
								})}
							</Card>
						);
					})}

					<Card padding={20} gap={12}>
						<Text size={font.lg} weight={600}>
							Onboarding a new client tenant
						</Text>
						<Text color={t.textDim} size={font.base} lineHeight={19}>
							Both steps happen in the customer's tenant, and both are required.
						</Text>
						<Col gap={10}>
							{[
								"Grant admin consent to this multi-tenant app registration.",
								"Register the client ID on Business Central's Microsoft Entra Applications page, set the state to Enabled, and grant permission sets that include the layout preview API.",
							].map((s, i) => (
								<Row key={s} gap={10} align="flex-start">
									<div
										style={{
											display: "flex",
											alignItems: "center",
											justifyContent: "center",
											width: 20,
											height: 20,
											flexShrink: 0,
											borderRadius: radius.pill,
											backgroundColor: t.bgRaised,
											borderWidth: 1,
											borderColor: t.borderStrong,
										}}
									>
										<text style={{ color: t.textDim, fontSize: font.xs }}>
											{String(i + 1)}
										</text>
									</div>
									{/* A <text> is a flex child like any other: without a column of its
                      own that may shrink to zero, it takes its content's intrinsic
                      width and paints straight past the card's edge. */}
									<Col style={{ flexGrow: 1, minWidth: 0 }}>
										<Text color={t.textDim} size={font.base} lineHeight={19}>
											{s}
										</Text>
									</Col>
								</Row>
							))}
						</Col>
						<Text color={t.textFaint} size={font.sm} lineHeight={17}>
							Test connection distinguishes the two: "not consented" means step
							1, "not registered in BC" means step 2.
						</Text>
					</Card>

					<div style={{ height: 8 }} />
				</Measure>
			</Scroll>
		</Col>
	);
}
