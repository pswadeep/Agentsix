#!/usr/bin/env python3
"""Builds docs/Multi-Agent-Council-Architecture.pdf (drafting-style technical document)."""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, Flowable, KeepTogether)

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'Multi-Agent-Council-Architecture.pdf')
INK = colors.HexColor('#1b1f24')
MUTED = colors.HexColor('#5b6470')
LINE = colors.HexColor('#8a929c')
HAIR = colors.HexColor('#c9ced6')
FILL = colors.HexColor('#eef1f5')
ACCENT = colors.HexColor('#1f3a5f')
W, H = A4
M = 40

base = ParagraphStyle('base', fontName='Helvetica', fontSize=9.3, leading=13, textColor=INK)
small = ParagraphStyle('small', parent=base, fontSize=8, leading=10.5, textColor=MUTED)
cell = ParagraphStyle('cell', parent=base, fontSize=8.2, leading=10.6)
cellb = ParagraphStyle('cellb', parent=cell, fontName='Helvetica-Bold')
mono = ParagraphStyle('mono', parent=base, fontName='Courier', fontSize=8, leading=10.4)
h1 = ParagraphStyle('h1', parent=base, fontName='Helvetica-Bold', fontSize=12.5, leading=16, textColor=ACCENT, spaceBefore=12, spaceAfter=5)
h2 = ParagraphStyle('h2', parent=base, fontName='Helvetica-Bold', fontSize=9.8, leading=13, spaceBefore=7, spaceAfter=3)
title = ParagraphStyle('title', parent=base, fontName='Helvetica-Bold', fontSize=21, leading=25, textColor=ACCENT)
bul = ParagraphStyle('bul', parent=base, leftIndent=12, bulletIndent=2, spaceAfter=1.5)


def P(t, s=base): return Paragraph(t, s)
def B(t): return Paragraph(t, bul, bulletText='-')
def H1(n, t): return Paragraph('%s&nbsp;&nbsp;%s' % (n, t.upper()), h1)


def table(rows, widths, head=True, mono_cols=()):
    data = []
    for r_i, row in enumerate(rows):
        out = []
        for c_i, c in enumerate(row):
            st = cellb if (head and r_i == 0) else (ParagraphStyle('m', parent=cell, fontName='Courier', fontSize=7.6) if c_i in mono_cols and r_i > 0 else cell)
            out.append(Paragraph(str(c), st))
        data.append(out)
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
    ts = [('GRID', (0, 0), (-1, -1), 0.4, LINE), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
          ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4)]
    if head: ts.append(('BACKGROUND', (0, 0), (-1, 0), FILL))
    t.setStyle(TableStyle(ts))
    return t


# ------------------------------------------------------------------ architecture drawing
class Diagram(Flowable):
    def __init__(self, width=515, height=530):
        super().__init__(); self.width = width; self.height = height

    def wrap(self, *a): return self.width, self.height

    def box(self, c, x, y, w, h, title, sub=None, n=None, fill=FILL, bold=True, dash=False):
        c.setStrokeColor(INK); c.setLineWidth(0.8); c.setFillColor(fill)
        if dash: c.setDash(3, 2)
        c.rect(x, y, w, h, fill=1, stroke=1); c.setDash()
        c.setFillColor(INK)
        ty = y + h / 2 + (3 if sub else -3)
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 8.2)
        c.drawCentredString(x + w / 2, ty, title)
        if sub:
            c.setFont('Helvetica', 6.6); c.setFillColor(MUTED)
            for i, line in enumerate(sub.split('\n')):
                c.drawCentredString(x + w / 2, ty - 9.5 - i * 8, line)
        if n is not None:
            c.setFillColor(colors.white); c.setStrokeColor(INK); c.circle(x, y + h, 6.5, fill=1, stroke=1)
            c.setFillColor(INK); c.setFont('Helvetica-Bold', 7.5); c.drawCentredString(x, y + h - 2.6, str(n))

    def arrow(self, c, pts, dash=False, head=True):
        c.setStrokeColor(INK); c.setFillColor(INK); c.setLineWidth(0.8)
        if dash: c.setDash(3, 2)
        p = c.beginPath(); p.moveTo(*pts[0])
        for q in pts[1:]: p.lineTo(*q)
        c.drawPath(p, stroke=1, fill=0); c.setDash()
        if head:
            (x0, y0), (x1, y1) = pts[-2], pts[-1]
            ah = 4.5
            if abs(x1 - x0) < 1e-6:
                d = 1 if y1 > y0 else -1
                tri = [(x1, y1), (x1 - 2.6, y1 - d * ah), (x1 + 2.6, y1 - d * ah)]
            else:
                d = 1 if x1 > x0 else -1
                tri = [(x1, y1), (x1 - d * ah, y1 - 2.6), (x1 - d * ah, y1 + 2.6)]
            p = c.beginPath(); p.moveTo(*tri[0]); p.lineTo(*tri[1]); p.lineTo(*tri[2]); p.close()
            c.drawPath(p, fill=1, stroke=0)

    def draw(self):
        c = self.canv
        top = self.height
        # inputs
        self.box(c, 0, top - 40, 170, 38, 'TELEGRAM BOT', 'private chat, allow-listed chat ids')
        self.box(c, 325, top - 40, 170, 38, 'LOCALHOST PAGE  :8080', 'Node server: /api/ask, /api/feed')
        self.arrow(c, [(85, top - 40), (85, top - 62)])
        self.arrow(c, [(410, top - 40), (410, top - 62)])
        self.box(c, 0, top - 102, 170, 40, 'EVERY 5s + POLL TELEGRAM', 'getUpdates, no public URL needed', n=1)
        self.box(c, 325, top - 102, 170, 40, 'WEB PROMPT WEBHOOK', 'secret check, 202 accepted / 401', n=2)
        # to master plan
        cy = top - 170
        self.box(c, 95, cy, 305, 50, 'MASTER: PLAN   (Claude A)', 'answer directly, OR emit a JSON plan:\nroles + self-contained tasks + combine rule', n=3, fill=colors.white)
        self.arrow(c, [(85, top - 102), (85, top - 116), (165, top - 116), (165, cy + 50)])
        self.arrow(c, [(410, top - 102), (410, top - 116), (330, top - 116), (330, cy + 50)])
        c.setFont('Helvetica', 6.4); c.setFillColor(MUTED)
        c.drawString(405, cy + 29, 'standby: Claude B'); c.drawString(405, cy + 21, '> Gemini A > ChatGPT A')
        # workers container
        wy = cy - 112; wh = 92
        c.setStrokeColor(INK); c.setLineWidth(0.8); c.setDash(4, 2.5); c.rect(0, wy, 495, wh); c.setDash()
        c.setFont('Helvetica-Bold', 7.4); c.setFillColor(INK)
        c.drawString(10, wy + wh - 11, 'WORKERS: EXECUTE   parallel, one failover chain per role')
        c.setFillColor(colors.white); c.circle(0, wy + wh, 6.5, fill=1, stroke=1)
        c.setFillColor(INK); c.setFont('Helvetica-Bold', 7.5); c.drawCentredString(0, wy + wh - 2.6, '4')
        roles = [('research', 'Gemini A', 'Gemini B > Claude B'), ('quick', 'Gemini B', 'Gemini A > ChatGPT B'),
                 ('code', 'ChatGPT A', 'ChatGPT B > Claude B'), ('writing', 'ChatGPT B', 'ChatGPT A > Gemini A'),
                 ('analysis', 'Claude B', 'ChatGPT A > Gemini A')]
        for i, (r, a, fb) in enumerate(roles):
            x = 4.5 + i * 99
            c.setFillColor(colors.white); c.setStrokeColor(INK); c.rect(x, wy + 8, 90, 55, fill=1, stroke=1)
            c.setFillColor(MUTED); c.setFont('Courier', 7); c.drawCentredString(x + 45, wy + 51, r)
            c.setFillColor(INK); c.setFont('Helvetica-Bold', 8.4); c.drawCentredString(x + 45, wy + 38, a)
            c.setFillColor(MUTED); c.setFont('Helvetica', 6); c.drawCentredString(x + 45, wy + 24, 'fallback:'); c.drawCentredString(x + 45, wy + 16.5, fb)
        self.arrow(c, [(247, cy), (247, wy + wh)])
        # combine / review / deliver
        ky = wy - 56
        self.box(c, 95, ky, 305, 36, 'MASTER: COMBINE   (Claude A)', 'merge results, resolve contradictions, one answer', n=5, fill=colors.white)
        self.arrow(c, [(247, wy), (247, ky + 36)])
        ry = ky - 52
        self.box(c, 95, ry, 305, 36, 'REVIEWER: QA   (Claude B)', 'fix errors and gaps; keeps draft if review fails', n=6, fill=colors.white)
        self.arrow(c, [(247, ky), (247, ry + 36)])
        dy = ry - 52
        self.box(c, 95, dy, 305, 36, 'DELIVER', 'chunk to Telegram limits, publish to localhost feed', n=7, fill=colors.white)
        self.arrow(c, [(247, ry), (247, dy + 36)])
        oy = dy - 50
        self.box(c, 0, oy, 170, 32, 'TELEGRAM REPLY', 'sendMessage, 3800-char chunks', fill=FILL)
        self.box(c, 325, oy, 170, 32, 'LOCALHOST FEED', 'POST /api/publish, page polls', fill=FILL)
        self.arrow(c, [(247, dy), (247, dy - 12), (85, dy - 12), (85, oy + 32)])
        self.arrow(c, [(247, dy - 12), (410, dy - 12), (410, oy + 32)], head=True)
        # bypass for direct answers
        self.arrow(c, [(400, cy + 12), (507, cy + 12), (507, dy + 18), (400, dy + 18)], dash=True)
        c.saveState(); c.translate(513, (cy + dy) / 2); c.rotate(90)
        c.setFont('Helvetica', 6.4); c.setFillColor(MUTED); c.drawCentredString(0, 0, 'direct-answer path skips 4-6'); c.restoreState()


def title_block(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(INK); canvas.setLineWidth(0.9); canvas.rect(22, 22, W - 44, H - 44)
    canvas.setLineWidth(0.4); canvas.line(22, 40, W - 22, 40)
    canvas.setFont('Helvetica', 7.2); canvas.setFillColor(INK)
    canvas.drawString(30, 28, 'MULTI-AGENT COUNCIL  |  n8n orchestration: architecture and strategy')
    canvas.drawRightString(W - 30, 28, 'REV A  |  2026-11-11  |  SHEET %d' % doc.page)
    canvas.restoreState()


def build():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=M, rightMargin=M, topMargin=36, bottomMargin=52,
                          title='Multi-Agent Council: n8n architecture and strategy', author='Swadeep')
    doc.addPageTemplates([PageTemplate(id='p', frames=[Frame(M, 52, W - 2 * M, H - 88, id='f', leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)], onPage=title_block)])
    S = []
    cw = W - 2 * M

    # ---- page 1
    S += [Spacer(1, 6), P('MULTI-AGENT COUNCIL', title), P('n8n workflow: one master agent, five worker agents, Telegram and localhost interface', ParagraphStyle('sub', parent=base, fontSize=10.5, leading=14, textColor=MUTED)), Spacer(1, 8)]
    S.append(table([
        ['Purpose', 'Combine 2 ChatGPT, 2 Claude and 2 Gemini API accounts into one system. A master agent plans the workflow for each prompt, worker agents execute it in parallel, the master combines the results, a reviewer checks them, and the answer returns to Telegram and a localhost page.'],
        ['Runs on', 'Docker Compose: n8n (editor 127.0.0.1:5678) and a small Node web server (127.0.0.1:8080). Everything is bound to this machine only.'],
        ['Deliverables', 'multi-agent-orchestrator.json (13-node workflow), web/ (localhost console), docker-compose.yml, .env.example, README, this document.'],
        ['Verified', '18 offline tests of the Code-node logic against mock APIs, plus an end-to-end run in a real n8n 2.35.7 instance (import, activate, Telegram path, web path, failover, bad-secret rejection).'],
    ], [80, cw - 80], head=False))

    S.append(H1('1', 'Before anything else: what "free keys" means'))
    S.append(P('The chat apps and the developer APIs are separate products with separate billing. n8n talks to the API, so each of the six slots needs an <b>API key</b>, not a ChatGPT, Claude or Gemini app login.'))
    S.append(Spacer(1, 4))
    S.append(table([
        ['Vendor', 'Chat-app account gives you', 'API key', 'Free route'],
        ['Google Gemini', 'Gemini app', 'Created in Google AI Studio', '<b>Yes.</b> Free tier covers Flash and Flash-Lite class models (gemini-3.5-flash, gemini-3.1-flash-lite). The Pro model is listed with no free tier. Limits are per project, so two keys in two separate projects give separate quotas.'],
        ['OpenAI', 'ChatGPT Free/Plus/Go', 'Separate platform billing', '<b>No general free tier.</b> Only paid Pro and Business plans receive monthly API credits; Free, Plus and Go are not eligible. Expect to add prepaid credit.'],
        ['Anthropic', 'Claude.ai plan', 'Separate Console billing', '<b>No free tier assumed.</b> Claude API usage is billed separately from a Claude plan. Expect to add prepaid credit.'],
    ], [62, 92, 92, cw - 246]))
    S.append(Spacer(1, 4))
    S.append(P('<b>Consequence for the design.</b> Every agent is optional: a slot without a key is skipped and its work falls through to the next agent in the chain. Three operating modes are supported with no code change:', base))
    S.append(Spacer(1, 3))
    S.append(table([
        ['Mode', 'Keys present', 'Behaviour'],
        ['Full council', 'all six', 'Strategy exactly as drawn in section 3.'],
        ['Free-only', 'Gemini A + B', 'Set MASTER_CHAIN=gemini_a,gemini_b. Gemini plans, works, combines and reviews (set REVIEWER_AGENT=gemini_b). Tested.'],
        ['Partial', 'any subset', 'Missing agents are skipped; roles fall back along their chains.'],
    ], [78, 80, cw - 158]))
    S.append(Spacer(1, 3))
    S.append(P('Not supported by design: using a chat subscription through its web session or cookies. That is not an API, breaks without notice and is against the vendors\' terms.', small))
    S.append(PageBreak())

    # ---- page 2: drawing
    S.append(H1('2', 'System architecture'))
    S.append(Diagram())
    S.append(Spacer(1, 6))
    S.append(table([
        ['PROJECT', 'Multi-Agent Council', 'DRAWING', 'A-01  Orchestration flow', 'REV', 'A'],
        ['SCALE', 'none (schematic)', 'DATE', '2026-11-11', 'SHEET', '2 / 6'],
    ], [58, 140, 56, 150, 36, cw - 440], head=False))
    S.append(PageBreak())

    # ---- strategy
    S.append(H1('3', 'Master and worker strategy'))
    S.append(P('<b>Decision.</b> Claude A is the master. Claude B is its hot standby and doubles as the analysis worker and reviewer. The other four agents are specialists grouped by vendor so that one vendor\'s outage or rate limit never removes a whole role.'))
    S.append(Spacer(1, 4))
    S.append(P('Why the master is a Claude agent (design judgement, not a benchmark result):', h2))
    for t in ['The master must return a strict JSON plan and then write one coherent final answer from several partial outputs. Instruction-following and long-form synthesis matter more than raw speed here.',
              'The master makes only two calls per prompt (plan, combine), so it is the cheapest place to spend the strongest model; workers make most of the calls and run on lighter models.',
              'Claude B is a second, independent account of the same vendor, so master failover keeps identical behaviour and prompt format.',
              'If you only have free keys, the chain moves to Gemini (section 1). The role split still holds because roles are configuration, not code.']:
        S.append(B(t))
    S.append(Spacer(1, 5))
    S.append(P('Role assignment and failover chains', h2))
    S.append(table([
        ['Role', 'Used for', 'Primary', 'Failover order'],
        ['master', 'plan, combine', 'Claude A', 'Claude B, Gemini A, ChatGPT A, Gemini B, ChatGPT B'],
        ['research', 'broad knowledge, long reading, gathering and summarising', 'Gemini A', 'Gemini B, Claude B, ChatGPT A'],
        ['quick', 'extraction, translation, formatting, short summaries', 'Gemini B', 'Gemini A, ChatGPT B, Claude B'],
        ['code', 'programming, debugging, maths, structured data', 'ChatGPT A', 'ChatGPT B, Claude B, Gemini A'],
        ['writing', 'drafting, rewriting, tone, alternative angles', 'ChatGPT B', 'ChatGPT A, Gemini A, Claude B'],
        ['analysis', 'reasoning, critique, trade-offs, risk', 'Claude B', 'ChatGPT A, Gemini A, ChatGPT B'],
        ['reviewer', 'final quality gate', 'Claude B', 'Gemini A, ChatGPT A, Claude A'],
    ], [48, 190, 56, cw - 294]))
    S.append(Spacer(1, 3))
    S.append(P('After its listed chain a worker task may still use any remaining agent as a last resort. Every chain can be overridden in .env (MASTER_CHAIN, ROLE_RESEARCH, ROLE_QUICK, ROLE_CODE, ROLE_WRITING, ROLE_ANALYSIS, REVIEWER_AGENT).', small))
    S.append(Spacer(1, 4))
    S.append(P('How the master "creates the workflow"', h2))
    S.append(P('For each prompt the master returns one of two JSON shapes. The worker stage is then built from the plan at run time, so the workflow is different for every prompt:'))
    S.append(Spacer(1, 3))
    S.append(Paragraph('{"mode":"direct","answer":"..."}<br/>{"mode":"delegate","summary":"...","combine":"how to merge",<br/>&nbsp;"tasks":[{"id":"t1","role":"research|quick|code|writing|analysis",<br/>&nbsp;&nbsp;"title":"...","instruction":"self-contained instruction"}]}', mono))
    S.append(Spacer(1, 3))
    S.append(P('Limits applied by the workflow: 1 to 5 tasks, unknown roles become analysis, tasks cannot see each other (so instructions must be self-contained), malformed JSON falls back to a single analysis task, and a plain-text reply is treated as a direct answer.', small))
    S.append(PageBreak())

    # ---- nodes
    S.append(H1('4', 'Workflow node reference'))
    S.append(table([
        ['#', 'Node', 'Type', 'Job'],
        ['1', 'Every 5s -> Poll Telegram', 'Schedule trigger + Code', 'Calls getUpdates (no public URL, so it works on localhost). Ignores chats not in the allow-list; in setup mode replies with the sender\'s chat id. Handles /start, /help, /agents. Sends an acknowledgement, then emits one job per message.'],
        ['2', 'Web Prompt -> Validate -> Valid? -> Respond 202 / 401', 'Webhook, Code, IF, Respond', 'POST /webhook/agents-prompt with header x-webhook-secret. Wrong secret or empty prompt gets 401; otherwise 202 returns immediately and the run continues in the background.'],
        ['3', 'Master: Plan', 'Code', 'Master chain call. Direct answer, or validated plan (section 3).'],
        ['4', 'Workers: Execute', 'Code', 'Runs all tasks with Promise.all. Each task walks its role chain until one agent answers.'],
        ['5', 'Master: Combine', 'Code', 'Merges worker output into one answer. If every master candidate fails, returns the raw worker outputs instead of an error.'],
        ['6', 'Reviewer: QA', 'Code', 'Skipped for direct answers, short drafts and degraded runs, or when REVIEW_ENABLED=false. Keeps the draft if the reviewer fails or returns under 40% of its length.'],
        ['7', 'Deliver: Telegram + Localhost', 'Code', 'POSTs the result to the page\'s /api/publish and sends the Telegram reply (prompts typed on the page are mirrored to the first allow-listed chat unless MIRROR_WEB_TO_TELEGRAM=false).'],
    ], [16, 118, 80, cw - 214]))
    S.append(Spacer(1, 5))
    S.append(P('Why Code nodes with one shared gateway instead of one node per agent', h2))
    S.append(P('The plan decides at run time which agents run and in which order they fail over, which is awkward to wire statically. One gateway library (Anthropic Messages, OpenAI Responses, Gemini generateContent adapters, per-agent cooldowns, key scrubbing) is injected into each Code node from workflows/src/lib.js by scripts/build_workflow.js. Keys come from environment variables, so no credentials are stored in the workflow file and nothing needs relinking after import.'))
    S.append(Spacer(1, 3))
    S.append(P('Localhost console (web/)', h2))
    for t in ['Zero-dependency Node server. /api/ask creates a job id, forwards the prompt to the n8n webhook with the secret, and returns at once. The browser polls /api/feed.',
              'n8n calls /api/publish (secret-protected) when a job finishes, from either channel, so Telegram conversations also appear on the page.',
              'The feed is kept in memory and mirrored to web/data/feed.json (last 200 items). A job with no reply after 10 minutes is shown as failed with a hint.',
              'Answers render through an escape-first mini markdown renderer; no external scripts or fonts are loaded.']:
        S.append(B(t))
    S.append(PageBreak())

    # ---- lifecycle + resilience
    S.append(H1('5', 'Request lifecycle'))
    S.append(table([
        ['Step', 'Telegram prompt', 'Localhost prompt'],
        ['1', 'Poller picks up the message within 5 s and replies "Master is planning".', 'Browser POSTs /api/ask; server stores a pending item and calls the n8n webhook.'],
        ['2', 'Job {jobId, source:telegram, chatId, prompt}.', 'n8n validates the secret and answers 202; job {jobId, source:web, prompt}.'],
        ['3', 'Master plans; workers run in parallel; master combines; reviewer checks.', 'Same pipeline.'],
        ['4', 'Reply sent to the originating chat in chunks of at most 3800 characters, with a footer naming the agents used.', 'Answer appears in the page; copy is sent to the first allow-listed Telegram chat.'],
        ['5', 'Result also published to the page feed.', 'Pending bubble becomes the answer, with chips showing master, workers (dashed = a fallback took over), reviewer and time.'],
    ], [30, (cw - 30) / 2, (cw - 30) / 2]))

    S.append(H1('6', 'Failure handling'))
    S.append(table([
        ['Event', 'Behaviour'],
        ['HTTP 429 from an agent', 'Next agent in the chain answers; the limited agent is skipped for 60 s.'],
        ['HTTP 5xx or network error', 'Next agent answers; 30 s cooldown (60 s for network errors).'],
        ['HTTP 401 or 403 (bad key)', 'Skipped for 15 minutes so a bad key is not retried on every task.'],
        ['HTTP 404 (wrong model name)', 'Skipped for 10 minutes. Fix the model in .env.'],
        ['All agents in a chain cooling down', 'They are tried once anyway as a last resort.'],
        ['Master plan unparseable', 'Single analysis task runs; raw JSON is never shown to the user.'],
        ['Some workers fail', 'Combine proceeds with the successful ones and notes the gaps.'],
        ['All combiners fail', 'Raw worker outputs are returned (flagged as unmerged).'],
        ['Nothing can answer', 'A clear message reaches both channels, for example "no agent has an API key configured".'],
        ['Provider error text contains a key', 'API-key and bot-token patterns are redacted before any message is sent.'],
    ], [150, cw - 150]))
    S.append(Spacer(1, 3))
    S.append(P('Cooldowns live in workflow static data, which n8n persists only for active (production) runs. Cost control: a prompt costs one plan call, up to five worker calls, one combine call and one review call; set REVIEW_ENABLED=false or lower WORKER_MAX_TOKENS to reduce it.', small))

    S.append(H1('7', 'Security'))
    for t in ['Telegram: only chat ids in TELEGRAM_ALLOWED_CHAT_IDS can spend your keys; other senders get no reply. While the list is empty the bot only reveals the sender\'s own chat id.',
              'Webhook and publish endpoints require WEBHOOK_SECRET (constant-time compare on the publish side). The page server refuses to start without it.',
              'n8n and the page publish ports on 127.0.0.1 only. Do not expose them to the internet without authentication in front.',
              'Keys live only in .env (never in the workflow JSON). N8N_BLOCK_ENV_ACCESS_IN_NODE=false is required for Code nodes to read them; that setting lets any workflow author on this n8n read all environment variables, which is acceptable for a single-user local install.',
              'Executions that succeed are not stored (the poller would otherwise create about 17,000 rows a day); errors are kept and pruned after 48 hours. Switch saveDataSuccessExecution on in workflow settings when debugging.']:
        S.append(B(t))
    S.append(PageBreak())

    # ---- setup
    S.append(H1('8', 'Setup and verification'))
    S.append(table([
        ['Step', 'Action'],
        ['1', 'cp .env.example .env. Set WEBHOOK_SECRET (openssl rand -hex 24) and whichever API keys you have.'],
        ['2', 'Telegram: create a bot with @BotFather, put the token in TELEGRAM_BOT_TOKEN.'],
        ['3', 'docker compose up -d. Open http://localhost:5678 and create the n8n owner account.'],
        ['4', 'docker compose exec n8n n8n import:workflow --input=/import/multi-agent-orchestrator.json, then restart n8n (docker compose restart n8n). Alternatively use Workflows > Import from file.'],
        ['5', 'Open the workflow and switch it to Active (production webhooks and the 5 s poller only run when active).'],
        ['6', 'Message your bot. It replies with your chat id; put it in TELEGRAM_ALLOWED_CHAT_IDS and run docker compose up -d again.'],
        ['7', 'Send /agents in Telegram: every agent with a key should show as ready. Then send a real prompt, or open http://localhost:8080.'],
    ], [30, cw - 30]))
    S.append(Spacer(1, 4))
    S.append(P('Verification already performed', h2))
    S.append(table([
        ['Check', 'Result'],
        ['Workflow JSON: 13 nodes, all connections resolve, every Code node parses', 'pass'],
        ['18 offline scenarios (allow-list, setup mode, direct answer, delegate path, worker and master failover, whole-vendor outage, key subset, no keys, key redaction, malformed plan, degraded combine, secret validation, chunking, web proxy, mirror toggle)', '18 / 18 pass'],
        ['Real n8n 2.35.7: CLI import, publish, activation, webhook 401 on bad secret', 'pass'],
        ['Real n8n: Telegram prompt -> plan -> 3 parallel workers -> combine -> review -> Telegram reply and page feed', 'pass'],
        ['Real n8n: page prompt -> same pipeline -> feed and Telegram mirror; gemini_a forced to 429 -> Gemini B took over', 'pass'],
    ], [cw - 70, 70]))
    S.append(Spacer(1, 4))
    S.append(P('<b>Not verified:</b> calls to the real OpenAI, Anthropic and Gemini endpoints (no keys were available here, so the vendor adapters follow the published request formats and were tested against mocks), the Docker Compose stack itself, and a real Telegram bot. The first live run is the real test of those three; /agents and a single "hello" prompt are the quickest checks. If an OpenAI-compatible endpoint rejects /v1/responses, set OPENAI_API_MODE=chat.', base))

    S.append(H1('9', 'Extending'))
    for t in ['Add a role: add an entry to ROLES and ROLE_INFO in workflows/src/lib.js, then run node scripts/build_workflow.js and re-import. The master learns the new role automatically from the role list in its prompt.',
              'Point any slot at another provider: set OPENAI_BASE_URL (or the Anthropic/Gemini equivalent) to an OpenAI-compatible gateway and set the model name.',
              'Dependent tasks (task B needs the output of task A): not in this version; tasks run in a single parallel wave. The combine step is where results meet.',
              'Rebuild and test: node scripts/build_workflow.js && node tests/run_nodes.js.']:
        S.append(B(t))

    S.append(H1('10', 'Sources checked'))
    for t in ['Gemini API pricing and free-tier model list: https://ai.google.dev/gemini-api/docs/pricing',
              'Gemini API rate limits (per project, free usage tier): https://ai.google.dev/gemini-api/docs/rate-limits',
              'OpenAI: API billed separately from ChatGPT; credits only for eligible paid plans: https://developers.openai.com/api/docs/guides/chatgpt-api-credits',
              'OpenAI model IDs (gpt-6 family): https://developers.openai.com/api/docs/models',
              'Anthropic: "Why is Claude API usage billed separately from my paid Claude plan" (support.claude.com article 9876003). The page itself could not be fetched here; the title was read from search results.',
              'Model names and free-tier details change often; confirm them against the vendor pages before relying on them.']:
        S.append(B(t))
    doc.build(S)
    print('wrote', os.path.normpath(OUT))


if __name__ == '__main__':
    build()
