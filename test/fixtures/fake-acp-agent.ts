#!/usr/bin/env bun
/**
 * A stand-in ACP agent for testing the client.
 *
 * Speaks enough of the protocol to exercise the paths that matter: capability
 * negotiation, session creation with MCP servers attached, streamed updates, a
 * permission request back to the client, and a filesystem call back to the client.
 *
 * The read loop never awaits a reply it is itself responsible for reading — an
 * agent-initiated request is handled off the loop, or the two sides deadlock.
 */
const permissionAnswers = new Map<number, (v: string) => void>();
const fsAnswers = new Map<number, (v: string) => void>();

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const note = (s: string) => process.stderr.write(`${s}\n`);
let nextId = 1000;

/** Ask the client something and wait for its response, off the read loop. */
function ask(
	method: string,
	params: unknown,
	table: Map<number, (v: string) => void>,
): Promise<string> {
	const id = nextId++;
	return new Promise<string>((resolve) => {
		table.set(id, resolve);
		send({ jsonrpc: "2.0", id, method, params });
	});
}

async function handlePrompt(msg: {
	id?: number;
	params?: Record<string, unknown>;
}): Promise<void> {
	const sessionId = String(msg.params?.sessionId);
	const promptText = JSON.stringify(msg.params?.prompt);
	const update = (u: unknown) =>
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: { sessionId, update: u },
		});

	update({
		sessionUpdate: "plan",
		entries: [{ content: "Widen the column", status: "in_progress" }],
	});
	// Reasoning streams a token at a time, exactly as a real agent does. Coalescing this
	// is the point: unbuffered, one paragraph became sixty timeline rows of one word.
	for (const t of ["I should ", "widen ", "the column."]) {
		update({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: t },
		});
	}
	update({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "Looking" },
	});
	update({
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: " at it." },
	});
	update({
		sessionUpdate: "tool_call",
		toolCallId: "tc-1",
		title: "layout_render",
		kind: "other",
		status: "in_progress",
	});
	update({
		sessionUpdate: "tool_call_update",
		toolCallId: "tc-1",
		status: "completed",
	});

	if (promptText.includes("edit")) {
		// The real wire shape captured from Claude Code and opencode: content items are
		// {type:"diff", path, oldText, newText} and {type:"content", content: ContentBlock},
		// not bare ContentBlocks. A status-only update in between carries no content at
		// all, which is the common case a test has to prove does not clear an already
		// captured diff.
		update({
			sessionUpdate: "tool_call",
			toolCallId: "tc-edit",
			title: "edit",
			kind: "edit",
			status: "pending",
			locations: [{ path: "Default.rdl" }],
		});
		update({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-edit",
			status: "in_progress",
		});
		update({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-edit",
			status: "completed",
			title: "Edit Default.rdl",
			content: [
				{
					type: "content",
					content: { type: "text", text: "Edit applied successfully." },
				},
				{
					type: "diff",
					path: "Default.rdl",
					oldText: "line two\nINVOICE NO: 12345\nline four",
					newText: "line two\nline four",
				},
			],
		});
	}

	if (promptText.includes("write")) {
		const answer = await ask(
			"session/request_permission",
			{
				sessionId,
				toolCall: {
					toolCallId: "tc-2",
					title: "Write Default.rdl",
					kind: "edit",
					rawInput: { path: "Default.rdl" },
				},
				options: [
					{ optionId: "yes", name: "Allow once", kind: "allow_once" },
					{ optionId: "no", name: "Reject", kind: "reject_once" },
				],
			},
			permissionAnswers,
		);
		note(`PERMISSION=${answer}`);
	}

	// Copilot CLI's shape: a human-readable title with the real tool name only in
	// rawInput.command. Matching on the title alone, our own free tools all stopped
	// and asked — which made the auto-allow policy silently do nothing there.
	if (promptText.includes("disguised")) {
		const answer = await ask(
			"session/request_permission",
			{
				sessionId,
				toolCall: {
					toolCallId: "tc-3",
					title: "Lint report layout",
					kind: "execute",
					rawInput: { command: "layout_lint /tmp/Default.rdl" },
				},
				options: [
					{ optionId: "yes", name: "Allow once", kind: "allow_once" },
					{ optionId: "always", name: "Always", kind: "allow_always" },
					{ optionId: "no", name: "Reject", kind: "reject_once" },
				],
			},
			permissionAnswers,
		);
		note(`PERMISSION=${answer}`);
	}

	// Claude Code's shape: the MCP-prefixed tool name as the title, empty rawInput.
	// The leading "_" of the prefix is a word character, so a \b-anchored match fails.
	if (promptText.includes("prefixed")) {
		const answer = await ask(
			"session/request_permission",
			{
				sessionId,
				toolCall: {
					toolCallId: "tc-4",
					title: "mcp__layout__layout_lint",
					kind: "other",
					rawInput: {},
				},
				options: [
					{ optionId: "yes", name: "Allow once", kind: "allow_once" },
					{ optionId: "no", name: "Reject", kind: "reject_once" },
				],
			},
			permissionAnswers,
		);
		note(`PERMISSION=${answer}`);
	}

	if (promptText.includes("readfile")) {
		const content = await ask(
			"fs/read_text_file",
			{ path: process.env.FAKE_READ_PATH },
			fsAnswers,
		);
		note(`READ_BACK=${content.slice(0, 40)}`);
	}

	send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
}

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk as Uint8Array, { stream: true });
	let nl = buffer.indexOf("\n");
	while (nl !== -1) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		nl = buffer.indexOf("\n");
		if (!line) continue;
		const msg = JSON.parse(line) as {
			id?: number;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
		};

		if (msg.method === "initialize") {
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					protocolVersion: 1,
					agentCapabilities: {
						loadSession: true,
						promptCapabilities: { image: true, embeddedContext: true },
						mcpCapabilities: { http: false, sse: false },
					},
					authMethods: [],
				},
			});
			continue;
		}

		if (msg.method === "session/new") {
			// Echoed so the test can assert the MCP wiring and the cwd confinement.
			note(`MCP_SERVERS=${JSON.stringify(msg.params?.mcpServers)}`);
			note(`CWD=${msg.params?.cwd}`);
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					sessionId: "sess-1",
					modes: {
						currentModeId: "manual",
						availableModes: [
							{
								id: "manual",
								name: "Manual",
								description: "Always ask before making changes",
							},
							{
								id: "auto",
								name: "Auto",
								description: "Accept edits automatically",
							},
						],
					},
					configOptions: [
						{
							id: "mode",
							name: "Mode",
							type: "select",
							currentValue: "manual",
							options: [
								{ value: "manual", name: "Manual" },
								{ value: "auto", name: "Auto" },
							],
						},
						{
							id: "model",
							name: "Model",
							type: "select",
							currentValue: "fake-small",
							options: [
								{ value: "fake-small", name: "Fake Small" },
								{ value: "fake-big", name: "Fake Big" },
							],
						},
					],
				},
			});
			continue;
		}

		if (msg.method === "session/prompt") {
			void handlePrompt(msg); // off the loop, so replies can still be read
			continue;
		}

		if (msg.method === "session/load") {
			// Replay one update so a resuming client exercises its "ignore the replay,
			// keep the persisted transcript" path, then acknowledge. The reply is sent
			// synchronously here — never awaited from inside this read loop, which would
			// deadlock, since this loop is what would deliver it.
			note(`LOAD=${msg.params?.sessionId}`);
			send({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: msg.params?.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: "(replayed history — should be ignored)",
						},
					},
				},
			});
			send({ jsonrpc: "2.0", id: msg.id, result: {} });
			continue;
		}

		if (msg.method === "session/set_mode") {
			note(`SET_MODE=${msg.params?.modeId}`);
			send({ jsonrpc: "2.0", id: msg.id, result: {} });
			continue;
		}

		if (msg.method === "session/set_model") {
			note(`SET_MODEL=${msg.params?.modelId}`);
			send({ jsonrpc: "2.0", id: msg.id, result: {} });
			continue;
		}

		// A response to something this agent asked the client.
		if (msg.id !== undefined && msg.method === undefined) {
			const r = msg.result as
				| { outcome?: { outcome: string; optionId?: string }; content?: string }
				| undefined;
			const perm = permissionAnswers.get(msg.id);
			if (perm && r?.outcome) {
				permissionAnswers.delete(msg.id);
				perm(r.outcome.optionId ?? r.outcome.outcome);
			}
			const fs = fsAnswers.get(msg.id);
			if (fs && r?.content !== undefined) {
				fsAnswers.delete(msg.id);
				fs(r.content);
			}
		}
	}
}
