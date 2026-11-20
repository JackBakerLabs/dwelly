const $ = id => document.getElementById(id);
let state, selectedEvent, selectedTrace;
let llm = false;
let observer = false, refreshing = false, lastRefresh;
const explanations = { Ingest: 'Receive & save', Route: 'Find the case', Assess: 'Choose an action', Validate: 'Check the proposal', Act: 'Call the API', Checkpoint: 'Save the result' };
const actionNames = { open: 'Open a maintenance case', update: 'Update the existing case', ask: 'Ask for clarification', wait: 'Wait for new evidence', review: 'Request human review', outOfScope: 'Record as outside maintenance scope' };
function explain(traces) {
  const decision = traces.find(t => t.node === 'Validate' && t.edge === 'Act')?.outcome;
  const index = state.messages.findIndex(m => m.id === selectedEvent);
  const earlier = new Set(state.messages.slice(0, index).map(m => m.id));
  const issueId = traces.find(t => t.issueId)?.issueId;
  const confirmed = state.traces.filter(t => (!issueId || t.issueId === issueId) && t.node === 'Checkpoint' && t.edge === 'confirmed' && t.outcome?.id && t.outcome?.urgency);
  const before = confirmed.filter(t => earlier.has(t.eventId)).at(-1)?.outcome;
  const after = confirmed.filter(t => earlier.has(t.eventId) || t.eventId === selectedEvent).at(-1)?.outcome;
  $('story').replaceChildren(); $('comparison').replaceChildren();
  if (index < 0) { empty($('story'), observer ? 'Waiting for events from the worker.' : 'Start with the first report. We will show the decision, its recorded reason, and exactly what changed.'); return; }
  if (observer && !issueId) { empty($('story'), 'This event has not been linked to an issue. Inspect its recorded routing logs below.'); return; }
  const message = state.messages[index];
  const facts = [ ['Incoming evidence', `${(message.actor?.name ?? 'System')} reports: ${(message.payload.body ?? message.payload.text ?? JSON.stringify(message.payload))}`], ['Decision', decision ? (actionNames[decision.kind] ?? decision.kind) : 'No new assessed action'], ['Recorded reason', decision?.reason ?? traces.at(-1)?.reason ?? 'No trace recorded'] ];
  for (const [title, text] of facts) { const card = element('div', undefined, 'story-card'); card.append(element('h3', title), element('p', text)); $('story').append(card); }
  const beforeText = before ? `${before.urgency} priority · ${before.status}` : observer ? 'No confirmed snapshot' : 'No remote case';
  const afterText = after ? `${after.urgency} priority · ${after.status}` : observer ? 'No confirmed snapshot' : 'No remote case';
  const sameCase = before && after && before.id === after.id;
  const table = element('table'); const head = element('tr'); head.append(element('th', 'Before this message'), element('th', 'After this message')); const row = element('tr'); row.append(element('td', beforeText), element('td', afterText)); table.append(head, row);
  $('comparison').append(table, element('p', observer ? 'Comparison uses confirmed snapshots for this issue. Pending or uncertain actions are not shown as successful changes.' : sameCase ? 'Same remote case ID retained. No second case was created.' : after ? 'One remote case created and linked to the local issue.' : 'No remote case write confirmed.', 'hint'));
}
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function empty(container, text) { container.append(element('p', text, 'empty')); }
function render() {
  $('progress').textContent = observer ? `${state.position} events · ${state.pending} pending · cursor ${state.cursor}` : `${state.position} of ${state.total} messages delivered`;
  if (!state.messages.some(m => m.id === selectedEvent)) selectedEvent = state.messages.at(-1)?.id;
  $('notice').textContent = state.notice;
  $('step').disabled = state.busy || state.position >= state.total;
  $('duplicate').disabled = state.busy || state.position === 0;
  $('message-count').textContent = String(state.messages.length);
  $('messages').replaceChildren();
  for (const message of state.messages) {
    const card = element('article', undefined, 'message');
    card.append(element('strong', (message.actor?.name ?? 'System')), element('div', `${message.id} · ${new Date(message.occurred_at).toLocaleString()}${message.processingStatus ? ' · ' + message.processingStatus : ''}`, 'meta'), element('p', (message.payload.body ?? message.payload.text ?? JSON.stringify(message.payload))));
    $('messages').append(card);
  }
  if (!state.messages.length) empty($('messages'), 'No messages received yet. Deliver the first report to start.');
  $('next').textContent = state.nextMessage ? `${state.nextMessage.actor.name}: ${state.nextMessage.payload.body}` : 'All demo messages delivered.';
  $('state').replaceChildren();
  const eventIssue = state.traces.find(t => t.eventId === selectedEvent && t.issueId)?.issueId;
  const issue = observer ? state.issues.find(i => i.id === eventIssue || i.evidence.some(e => e.eventId === selectedEvent)) : state.issues[0];
  if (issue) {
    const list = element('dl');
    for (const [label, value] of Object.entries({Status: ({ active: 'Active — ready for new evidence', waiting: 'Waiting for new evidence', awaitingReply: 'Waiting for a reply', review: 'Needs human review', outOfScope: 'Outside maintenance scope' })[issue.status] ?? issue.status, Urgency: issue.urgency ?? 'Unassigned', 'Case identity': issue.remoteCase ? 'One linked remote case — see raw state for IDs' : 'No remote case yet', Title: issue.remoteCase?.title ?? '—', Waiting: issue.waiting?.trigger.condition ?? 'No active wait', 'Human action': issue.humanAction ?? 'None'})) {
      const detail = element('dd'); detail.append(element('span', value, label === 'Urgency' ? `badge ${value}` : ''));
      list.append(element('dt', label), detail);
    }
    $('state').append(list);
  } else empty($('state'), observer ? 'No linked issue for the selected event yet.' : 'No case yet. A case is created only after a validated open decision.');
  $('model-diagnostics').hidden = !llm;
  $('model-diagnostics-data').textContent = JSON.stringify(state.diagnostics ?? [], null, 2);
  $('raw-state').textContent = JSON.stringify(issue ?? {}, null, 2);
  $('coordination').hidden = !observer;
  $('coordination-state').textContent = JSON.stringify(state.coordination ?? {}, null, 2);
  const filter = $('event-filter'); filter.replaceChildren();
  for (const [index, message] of state.messages.entries()) { const option = element('option', `Message ${index + 1} · ${(message.actor?.name ?? 'System')}`); option.value = message.id; filter.append(option); }
  if (!state.messages.length) filter.append(element('option', 'No events yet'));
  if (!state.messages.some(m => m.id === selectedEvent)) selectedEvent = state.messages.at(-1)?.id;
  if (selectedEvent) filter.value = selectedEvent;
  const traces = state.traces.filter(t => t.eventId === selectedEvent);
  explain(traces);
  const visited = new Set(traces.map(t => t.node));
  $('graph').replaceChildren();
  for (const [node, description] of Object.entries(explanations)) {
    const box = element('button', undefined, `node${visited.has(node) ? ' visited' : ''}${traces.at(-1)?.node === node ? ' last' : ''}`);
    box.disabled = !visited.has(node);
    box.setAttribute('aria-label', `${node}: ${description}${visited.has(node) ? '. View recorded log' : '. Not visited'}`);
    box.onclick = () => { selectedTrace = traces.find(t => t.node === node); render(); $('trace-detail').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    box.append(element('strong', description), element('small', node)); $('graph').append(box);
  }
  $('logs').replaceChildren();
  if (!traces.length) empty($('logs'), 'The actual execution trace will appear here.');
  selectedTrace = traces.find(t => JSON.stringify(t) === JSON.stringify(selectedTrace)) ?? traces.at(-1);
  for (const trace of traces) {
    const button = element('button', undefined, `log${trace === selectedTrace ? ' selected' : ''}`);
    button.append(element('strong', `${trace.node} → ${trace.edge}`), element('span', trace.reason));
    button.onclick = () => { selectedTrace = trace; render(); }; $('logs').append(button);
  }
  $('trace-detail').textContent = selectedTrace ? JSON.stringify(selectedTrace, null, 2) : 'Select a log entry to inspect evidence IDs, proposed actions and API outcomes.';
  $('writes').replaceChildren(); $('write-count').textContent = `${state.writes.length} ${observer ? 'action intents' : 'writes'} · ${state.intents.filter(i => i.state === 'confirmed').length} confirmed`;
  for (const write of state.writes) { const details = element('details'); details.append(element('summary', `${({ createCase: 'Case created', patchCase: 'Existing case updated', sendMessage: 'Message sent' })[write.operation] ?? write.operation}${write.state ? ' · ' + write.state : ''} · expand for exact recorded data`), element('pre', JSON.stringify(write, null, 2))); $('writes').append(details); }
  if (!state.writes.length) empty($('writes'), observer ? 'No action intents recorded yet.' : 'No API writes. Simulated requests will appear after a permitted action.');
}
async function load(path = '/api/state') {
  if (refreshing || (observer && path !== '/api/state')) return;
  refreshing = true;
  const openDetails = [...document.querySelectorAll('details')].map((el,index) => el.open ? index : -1);
  const previousScroll = window.scrollY;
  for (const id of ['step', 'duplicate', 'reset']) $(id).disabled = true;
  $('notice').classList.remove('error');
  if (llm && path === '/api/step') $('notice').textContent = 'Calling the model and validating its response… This may take up to 90 seconds, including one correction attempt.';
  try {
    const response = await fetch(path, { method: path === '/api/state' ? 'GET' : 'POST', signal: AbortSignal.timeout(llm && path !== '/api/state' ? 100000 : 5000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed');
    const previous = state?.position; const followingLatest = !selectedEvent || selectedEvent === state?.messages.at(-1)?.id; state = data;
    if ((!observer || followingLatest) && state.position !== previous) selectedEvent = state.messages.at(-1)?.id;
    render();
    lastRefresh = new Date().toLocaleTimeString();
    $('connection').textContent = observer ? `Database connected · last refreshed ${lastRefresh} · session ${state.session}` : '';
    if (observer) { document.querySelectorAll('details').forEach((el,index) => { el.open = openDetails.includes(index); }); window.scrollTo(0, previousScroll); }
  } catch (error) { $('notice').textContent = error.message + (observer ? ' Showing the last successful snapshot, if any.' : ' — check that npm run demo is running, then refresh.'); $('notice').classList.add('error'); if (observer) $('connection').textContent = `Disconnected · last successful refresh: ${lastRefresh ?? 'never'}`; }
  finally { refreshing = false; $('reset').disabled = !!state?.busy; if (state) { $('step').disabled = state.busy || state.position >= state.total; $('duplicate').disabled = state.busy || state.position === 0; } }
}
$('step').onclick = () => load('/api/step');
$('duplicate').onclick = () => load('/api/duplicate');
$('reset').onclick = () => load('/api/reset');
$('event-filter').onchange = event => { selectedEvent = event.target.value; render(); };
async function start() {
  try {
    const response = await fetch('/api/config', {signal:AbortSignal.timeout(5000)});
    const config = await response.json(); observer = config.observer === true; llm = config.assessment === 'llm';
    if (llm) {
      document.title = 'Dwelly · LLM demo';
      $('mode-tag').textContent = 'REAL LLM · SIMULATED API';
      $('page-title').textContent = 'Watch the model assess a real report.';
      $('subtitle').textContent = `${config.provider} / ${config.model}`;
      $('disclosure').textContent = 'Real model calls, real graph and SQLite; simulated Dwelly actions. Delivering a message sends archived evidence and guidance to the configured model provider and may incur charges. Decisions can differ from the scripted walkthrough. No live Dwelly records or messages are changed. Credentials stay on the server.';
      $('footer').textContent = 'Archived case-04 messages · real LLM judgments, not predetermined outcomes · provider errors or invalid proposals are held for review, never replaced with scripted answers.';
    }
    if (observer) {
      document.title = 'Dwelly · Live observer';
      $('mode-tag').textContent = 'READ-ONLY OBSERVER';
      $('page-title').textContent = 'Watch the worker process events.';
      $('subtitle').textContent = `Session: ${config.session}`;
      $('disclosure').textContent = `Reading ${config.database}. No model calls or actions are triggered by this dashboard. Refreshes every second; only committed records are visible. Database connectivity does not prove the worker is running.`;
      for (const id of ['step','duplicate','reset']) $(id).hidden = true;
      $('next').parentElement.hidden = true;
      $('footer').textContent = 'Read-only observer · current case follows the selected event · graph shows recorded stages, not hidden model reasoning. Fast intermediate stages may occur between refreshes.';
    }
    await load();
    if (observer) setInterval(() => load(), 1000);
  } catch (error) { $('notice').textContent = `Cannot connect: ${error.message}. Refresh once the dashboard server is running.`; }
}
start();
