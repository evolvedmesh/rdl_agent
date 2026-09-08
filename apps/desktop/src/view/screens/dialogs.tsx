/**
 * The onboarding dialogs.
 *
 * Everything a consultant needs to add a client and get their first render: the client,
 * a connection, the report, the layout binding, and the preview parameters. Each one
 * writes ordinary store state through the same REST endpoints the CLI uses.
 */

import type {
	Client,
	Connection,
	LayoutDetail,
	ReportSetting,
} from "@layout/core";
import { useState } from "react";
import type { Api, ReportCard } from "../api.ts";
import { Dropdown, Modal, useSubmit } from "../components/forms.tsx";
import {
	Button,
	cx,
	Field,
	Input,
	Spinner,
	TextArea,
} from "../components/ui.tsx";

export type DialogKind =
	| { kind: "add-client" }
	| { kind: "add-connection"; clientId: string; clientName: string }
	| { kind: "add-report" }
	| { kind: "add-layout"; reportId?: string }
	| { kind: "edit-params"; layout: LayoutDetail }
	| { kind: "duplicate"; layout: LayoutDetail }
	| { kind: "delete-layout"; layout: LayoutDetail };

export function Dialog({
	dialog,
	api,
	clients,
	connections,
	reports,
	onDone,
	onClose,
}: {
	dialog: DialogKind;
	api: Api;
	clients: Client[];
	connections: Connection[];
	reports: ReportCard[];
	onDone: () => void;
	onClose: () => void;
}) {
	switch (dialog.kind) {
		case "add-client":
			return <AddClient api={api} onDone={onDone} onClose={onClose} />;
		case "add-connection":
			return (
				<AddConnection
					api={api}
					clientId={dialog.clientId}
					clientName={dialog.clientName}
					existing={
						connections.filter((c) => c.clientId === dialog.clientId).length
					}
					onDone={onDone}
					onClose={onClose}
				/>
			);
		case "add-report":
			return <AddReport api={api} onDone={onDone} onClose={onClose} />;
		case "add-layout":
			return (
				<AddLayout
					api={api}
					clients={clients}
					connections={connections}
					reports={reports}
					presetReportId={dialog.reportId}
					onDone={onDone}
					onClose={onClose}
				/>
			);
		case "edit-params":
			return (
				<EditParams
					api={api}
					layout={dialog.layout}
					connections={connections}
					onDone={onDone}
					onClose={onClose}
				/>
			);
		case "delete-layout":
			return (
				<DeleteLayout
					api={api}
					layout={dialog.layout}
					onDone={onDone}
					onClose={onClose}
				/>
			);
		case "duplicate":
			return (
				<Duplicate
					api={api}
					layout={dialog.layout}
					clients={clients}
					connections={connections}
					onDone={onDone}
					onClose={onClose}
				/>
			);
	}
}

const Hint = ({ children }: { children: React.ReactNode }) => (
	<p className="text-xs leading-relaxed text-faint">{children}</p>
);

function AddClient({
	api,
	onDone,
	onClose,
}: {
	api: Api;
	onDone: () => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const { busy, error, run } = useSubmit();

	return (
		<Modal
			title="Add client"
			subtitle="A customer organisation whose reports you maintain."
			onClose={onClose}
			submitting={busy}
			error={error}
			onSubmit={() => {
				if (!name.trim()) return;
				void run(async () => {
					await api.createClient(name.trim());
					onDone();
				});
			}}
		>
			<Field label="Client name">
				<Input
					autoFocus
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Hawks Middle East"
				/>
			</Field>
			<Hint>
				Add at least one connection next — a tenant, environment and company
				this client's reports render against.
			</Hint>
		</Modal>
	);
}

function AddConnection({
	api,
	clientId,
	clientName,
	existing,
	onDone,
	onClose,
}: {
	api: Api;
	clientId: string;
	clientName: string;
	existing: number;
	onDone: () => void;
	onClose: () => void;
}) {
	const [label, setLabel] = useState("");
	const [tenantId, setTenantId] = useState("");
	const [environment, setEnvironment] = useState("");
	const [company, setCompany] = useState("");
	const { busy, error, run } = useSubmit();

	return (
		<Modal
			title={`Add connection · ${clientName}`}
			subtitle="A reachable Business Central target: tenant, environment and company."
			onClose={onClose}
			submitting={busy}
			error={error}
			onSubmit={() => {
				if (!tenantId.trim() || !environment.trim() || !company.trim()) return;
				void run(async () => {
					await api.createConnection({
						clientId,
						label: label.trim() || environment.trim(),
						tenantId: tenantId.trim(),
						environment: environment.trim(),
						company: company.trim(),
						// The first connection for a client becomes its default.
						isDefault: existing === 0,
					});
					onDone();
				});
			}}
		>
			<Field label="Tenant ID">
				<Input
					autoFocus
					value={tenantId}
					onChange={(e) => setTenantId(e.target.value)}
					placeholder="2c85ac3e-8f39-4971-beba-38bf7fefc87f"
					spellCheck={false}
				/>
			</Field>
			<Field label="Environment">
				<Input
					value={environment}
					onChange={(e) => setEnvironment(e.target.value)}
					placeholder="Production, Dev3, SANDBOX…"
				/>
			</Field>
			<Field label="Company">
				<Input
					value={company}
					onChange={(e) => setCompany(e.target.value)}
					placeholder="HAWKS MIDDLE EAST"
				/>
			</Field>
			<Hint>
				The company name goes into the OData URL as a string literal, so it must
				match Business Central exactly — case, spacing and punctuation included.
			</Hint>
			<Field label="Label (optional)">
				<Input
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="defaults to the environment name"
				/>
			</Field>
		</Modal>
	);
}

function AddReport({
	api,
	onDone,
	onClose,
}: {
	api: Api;
	onDone: () => void;
	onClose: () => void;
}) {
	const [reportId, setReportId] = useState("");
	const [name, setName] = useState("");
	const [source, setSource] = useState("");
	const { busy, error, run } = useSubmit();

	const numeric = Number(reportId);
	const valid =
		Number.isInteger(numeric) && numeric > 0 && name.trim().length > 0;

	return (
		<Modal
			title="Add report"
			subtitle="A Business Central report definition, identified by its object ID."
			onClose={onClose}
			submitting={busy}
			submitDisabled={!valid}
			error={error}
			onSubmit={() => {
				if (!valid) return;
				void run(async () => {
					await api.createReport(
						numeric,
						name.trim(),
						source.trim() || undefined,
					);
					onDone();
				});
			}}
		>
			<Field label="Report ID">
				<Input
					autoFocus
					inputMode="numeric"
					value={reportId}
					onChange={(e) => setReportId(e.target.value)}
					placeholder="61206"
				/>
			</Field>
			<Field label="Name">
				<Input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Calc. and Post VAT Settlement"
				/>
			</Field>
			<Field label="Source (optional)">
				<Input
					value={source}
					onChange={(e) => setSource(e.target.value)}
					placeholder="base, or the extension name"
				/>
			</Field>
			<Hint>
				Two clients' report 61206 are only the same report if both have the same
				extension installed. Reports are grouped by ID, but their datasets can
				differ.
			</Hint>
		</Modal>
	);
}

function AddLayout({
	api,
	clients,
	connections,
	reports,
	presetReportId,
	onDone,
	onClose,
}: {
	api: Api;
	clients: Client[];
	connections: Connection[];
	reports: ReportCard[];
	presetReportId?: string;
	onDone: () => void;
	onClose: () => void;
}) {
	// Held as "the user's explicit choice, if any". A useState initialiser runs once, so
	// seeding it from props would freeze an empty list if the data arrives a tick later.
	const [pickedReport, setPickedReport] = useState<string | null>(null);
	const [pickedClient, setPickedClient] = useState<string | null>(null);
	const [connectionId, setConnectionId] = useState<string | null>(null);
	const [filePath, setFilePath] = useState("");
	const [paramsXml, setParamsXml] = useState("");
	const { busy, error, run } = useSubmit();

	const reportId = pickedReport ?? presetReportId ?? reports[0]?.id ?? null;
	const clientId = pickedClient ?? clients[0]?.id ?? null;
	const forClient = connections.filter((c) => c.clientId === clientId);
	const effectiveConnection =
		connectionId ??
		forClient.find((c) => c.isDefault)?.id ??
		forClient[0]?.id ??
		null;

	return (
		<Modal
			title="Add layout"
			subtitle="Bind one client's layout file to a report."
			width={600}
			onClose={onClose}
			submitting={busy}
			error={error}
			onSubmit={() => {
				if (!reportId || !clientId || filePath.trim().length === 0) return;
				const layoutReportId = reportId;
				const layoutClientId = clientId;
				void run(async () => {
					await api.createLayout({
						reportId: layoutReportId,
						clientId: layoutClientId,
						connectionId: effectiveConnection,
						kind: filePath.trim().toLowerCase().endsWith(".docx")
							? "docx"
							: "rdl",
						filePath: filePath.trim(),
						paramsXml: paramsXml.trim() || null,
					});
					onDone();
				});
			}}
		>
			<Dropdown
				label="Report"
				value={reportId ?? undefined}
				onChange={setPickedReport}
				options={reports.map((r) => ({
					value: r.id,
					label: `${r.reportId} · ${r.name}`,
				}))}
				placeholder={
					reports.length === 0 ? "Add a report first" : "Select a report…"
				}
			/>
			<Dropdown
				label="Client"
				value={clientId ?? undefined}
				onChange={(v) => {
					setPickedClient(v);
					setConnectionId(null);
				}}
				options={clients.map((c) => ({ value: c.id, label: c.name }))}
				placeholder={
					clients.length === 0 ? "Add a client first" : "Select a client…"
				}
			/>
			<Dropdown
				label="Connection"
				value={effectiveConnection ?? undefined}
				onChange={setConnectionId}
				options={forClient.map((c) => ({
					value: c.id,
					label: `${c.environment} / ${c.company}`,
				}))}
				placeholder="This client has no connection yet"
			/>
			<LayoutFileField api={api} value={filePath} onChange={setFilePath} />
			<ParamsField
				value={paramsXml}
				onChange={setParamsXml}
				api={api}
				connectionId={effectiveConnection}
				reportNumber={reports.find((r) => r.id === reportId)?.reportId ?? null}
			/>
		</Modal>
	);
}

function EditParams({
	api,
	layout,
	connections,
	onDone,
	onClose,
}: {
	api: Api;
	layout: LayoutDetail;
	connections: Connection[];
	onDone: () => void;
	onClose: () => void;
}) {
	const [paramsXml, setParamsXml] = useState(layout.paramsXml ?? "");
	const [connectionId, setConnectionId] = useState<string | null>(
		layout.connectionId,
	);
	const { busy, error, run } = useSubmit();

	const forClient = connections.filter((c) => c.clientId === layout.clientId);

	return (
		<Modal
			title={`${layout.reportNumber} · ${layout.clientName}`}
			subtitle="Preview parameters and connection for this layout."
			width={640}
			onClose={onClose}
			submitting={busy}
			error={error}
			onSubmit={() =>
				void run(async () => {
					await api.updateLayout(layout.id, { paramsXml, connectionId });
					onDone();
				})
			}
		>
			<Dropdown
				label="Connection"
				value={connectionId ?? undefined}
				onChange={setConnectionId}
				options={forClient.map((c) => ({
					value: c.id,
					label: `${c.environment} / ${c.company}`,
				}))}
				placeholder="none"
			/>
			<ParamsField
				value={paramsXml}
				onChange={setParamsXml}
				rows={12}
				api={api}
				connectionId={connectionId}
				reportNumber={layout.reportNumber}
			/>
		</Modal>
	);
}

function Duplicate({
	api,
	layout,
	clients,
	connections,
	onDone,
	onClose,
}: {
	api: Api;
	layout: LayoutDetail;
	clients: Client[];
	connections: Connection[];
	onDone: () => void;
	onClose: () => void;
}) {
	const others = clients.filter((c) => c.id !== layout.clientId);
	const [pickedClient, setPickedClient] = useState<string | null>(null);
	const [targetPath, setTargetPath] = useState("");
	const { busy, error, run } = useSubmit();

	const clientId = pickedClient ?? others[0]?.id ?? null;
	const forClient = connections.filter((c) => c.clientId === clientId);
	const connectionId =
		forClient.find((c) => c.isDefault)?.id ?? forClient[0]?.id;

	return (
		<Modal
			title="Duplicate layout"
			subtitle={`Start ${clients.find((c) => c.id === clientId)?.name ?? "another client"} from ${layout.clientName}'s version of report ${layout.reportNumber}.`}
			width={600}
			onClose={onClose}
			submitting={busy}
			error={error}
			submitLabel="Duplicate"
			onSubmit={() => {
				if (!clientId || !targetPath.trim()) return;
				void run(async () => {
					await api.duplicateLayout({
						layoutId: layout.id,
						clientId,
						connectionId,
						targetPath: targetPath.trim(),
					});
					onDone();
				});
			}}
		>
			<p className="flex flex-wrap items-baseline gap-2 text-sm text-dim">
				Copying <span className="font-mono text-fg">{layout.filePath}</span>
			</p>
			<Dropdown
				label="To client"
				value={clientId ?? undefined}
				onChange={setPickedClient}
				options={others.map((c) => ({ value: c.id, label: c.name }))}
				placeholder="Add another client first"
			/>
			<Field label="New file path">
				<Input
					value={targetPath}
					onChange={(e) => setTargetPath(e.target.value)}
					placeholder="/home/you/reports/acme/61206/Default.rdl"
					spellCheck={false}
				/>
			</Field>
			<Hint>
				The file is copied, and the preview parameters come with it. Those
				parameters name records in {layout.clientName}'s company, so expect to
				edit them for the new tenant.
			</Hint>
		</Modal>
	);
}

/**
 * Removing a layout unbinds it — the row, its render history and its file watch.
 *
 * The file on disk stays. It is usually a working copy inside an AL project under
 * version control, and someone tidying up the app's list has not asked for their work
 * to be deleted. The dialog says so, because "Remove" is otherwise ambiguous enough
 * that a careful person would not press it.
 */
function DeleteLayout({
	api,
	layout,
	onDone,
	onClose,
}: {
	api: Api;
	layout: LayoutDetail;
	onDone: () => void;
	onClose: () => void;
}) {
	const { busy, error, run } = useSubmit();

	return (
		<Modal
			title="Remove layout"
			subtitle={`${layout.reportNumber} · ${layout.clientName}`}
			onClose={onClose}
			submitting={busy}
			error={error}
			submitLabel="Remove"
			onSubmit={() =>
				void run(async () => {
					await api.deleteLayout(layout.id);
					onDone();
				})
			}
		>
			<p className="text-sm">
				This unbinds the layout from {layout.clientName} and drops its render
				history. Any agent session running on it is stopped.
			</p>
			<div className="flex flex-col gap-1">
				<span className="text-xs text-dim">
					The file itself is not deleted:
				</span>
				<span className="rounded-sm bg-sunken px-2 py-1 font-mono text-xs break-all">
					{layout.filePath}
				</span>
			</div>
			<Hint>
				You can bind it again with Add layout, though its preview parameters
				will have to be set once more.
			</Hint>
		</Modal>
	);
}

/**
 * The layout path, with the desktop's own file chooser behind Browse.
 *
 * The field stays typeable and is still the source of truth: a chooser can be absent
 * (a headless box, a Linux desktop with neither zenity nor kdialog), and a path is
 * copy-pasteable from the editor the file is already open in. Browse fills the field;
 * it does not replace it.
 */
function LayoutFileField({
	api,
	value,
	onChange,
}: {
	api: Api;
	value: string;
	onChange: (v: string) => void;
}) {
	const [browsing, setBrowsing] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	const browse = async () => {
		setBrowsing(true);
		setNote(null);
		try {
			const res = await api.pickFile({
				startDir: parentDir(value),
				title: "Select a report layout",
			});
			if (res.ok) {
				onChange(res.path);
				return;
			}
			// Dismissing the dialog is an answer, not an error worth reporting.
			if (!res.cancelled) setNote(res.message);
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		} finally {
			setBrowsing(false);
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-end gap-2">
				<div className="min-w-0 flex-1">
					<Field label="Layout file">
						<Input
							value={value}
							onChange={(e) => onChange(e.target.value)}
							placeholder="/home/you/reports/hawks/61206/Default.rdl"
							spellCheck={false}
						/>
					</Field>
				</div>
				<Button onClick={() => void browse()} disabled={browsing}>
					{browsing ? (
						<>
							<Spinner /> Choosing…
						</>
					) : (
						"Browse…"
					)}
				</Button>
			</div>
			{note ? <p className="text-xs text-danger">{note}</p> : null}
			<Hint>
				An absolute path to a file you own. The agent edits it in place, so
				point this at a working copy — not at a pristine original you want to
				keep.
				<code className="ml-1 font-mono">.docx</code> is detected automatically.
			</Hint>
		</div>
	);
}

/** Open the chooser where the current path points, so a second pick starts nearby. */
function parentDir(path: string): string | undefined {
	const parent = path.trim().replace(/[/\\][^/\\]*$/, "");
	return parent.length > 1 ? parent : undefined;
}

/**
 * reportParamsXml is Business Central's own ReportParameters blob — around 900
 * characters of Options and DataItems for a report like 61206. Nobody can hand-author
 * it, so the field fetches it rather than pretending it is a normal input.
 *
 * Fetch lists every setting saved for that report in the connection's company (AL
 * codeunit 60796) and loads the one you pick. Every setting, not only the shared ones:
 * BC's own "shared with all users" flag cannot be turned on after a setting exists —
 * its page clears a primary-key field and the write is dropped — so filtering on it
 * would hide most of what a tenant actually has. The owner is in the picker instead.
 */
function ParamsField({
	value,
	onChange,
	rows = 8,
	api,
	connectionId,
	reportNumber,
}: {
	value: string;
	onChange: (v: string) => void;
	rows?: number;
	api: Api;
	connectionId: string | null;
	reportNumber: number | null;
}) {
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
	// Only shown when the tenant has more than one: with a single set of settings the
	// fetch is one press, and a picker over one option is furniture.
	const [choices, setChoices] = useState<ReportSetting[]>([]);
	const [chosen, setChosen] = useState<string | null>(null);

	const canFetch = connectionId !== null && reportNumber !== null;

	const load = async (settingsName?: string) => {
		if (!canFetch) return;
		setBusy(true);
		setNote(null);
		try {
			if (settingsName === undefined) {
				setChosen(null);
				const list = await api.reportSettings({
					connectionId,
					reportId: reportNumber,
				});
				if (!list.ok) {
					setChoices([]);
					setNote({
						bad: true,
						text: list.message ?? "Business Central refused the request.",
					});
					return;
				}
				const settings = list.settings ?? [];
				setChoices(settings.length > 1 ? settings : []);
				if (settings.length === 0) {
					setNote({
						bad: true,
						text:
							`Report ${reportNumber} has no saved settings in this company. Create one in BC ` +
							`(Report Settings → New), or capture the XML on the "Report Parameters for Layout ` +
							`Preview" page and paste it here.`,
					});
					return;
				}
				if (settings.length > 1) {
					setNote({
						bad: false,
						text: `${settings.length} saved settings — pick which one to load.`,
					});
					return;
				}
				const only = settings[0];
				if (!only) return;
				settingsName = only.name;
			}

			const got = await api.reportParams({
				connectionId,
				reportId: reportNumber,
				settingsName,
			});
			if (!got.ok || typeof got.paramsXml !== "string") {
				setNote({
					bad: true,
					text: got.message ?? "Business Central returned no parameters.",
				});
				return;
			}
			onChange(got.paramsXml);
			setChosen(got.settingsName || settingsName);
			setNote({
				bad: false,
				text: `Loaded "${got.settingsName || settingsName}" — ${got.paramsXml.length} characters.`,
			});
		} catch (e) {
			setNote({ bad: true, text: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};

	// The fetch sits above the editor, not below it: the box is tall enough to push a
	// control under it past the modal's fold, and this is the way the field gets filled.
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<Button onClick={() => void load()} disabled={busy || !canFetch}>
					{busy ? (
						<>
							<Spinner /> Fetching…
						</>
					) : (
						"Fetch from BC"
					)}
				</Button>
				<span className="min-w-0 flex-1 text-xs text-faint">
					{canFetch
						? `Reads the saved request-page settings for report ${reportNumber}.`
						: "Pick a report and a connection to fetch from Business Central."}
				</span>
			</div>

			{choices.length > 0 ? (
				<Dropdown
					label="Saved settings"
					value={chosen ?? undefined}
					onChange={(v) => void load(v)}
					options={choices.map((s) => ({
						value: s.name,
						label: s.user ? `${s.name} — ${s.user}` : s.name,
					}))}
					placeholder="Pick one to load…"
				/>
			) : null}

			{note ? (
				<p className={cx("text-xs", note.bad ? "text-danger" : "text-ok")}>
					{note.text}
				</p>
			) : null}

			<Field label="Preview parameters (reportParamsXml)">
				<TextArea
					rows={rows}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder="<?xml version=… fetched from Business Central"
					spellCheck={false}
				/>
			</Field>
		</div>
	);
}
