import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  CircleStop,
  Clipboard,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FolderOpen,
  Gauge,
  HardDrive,
  Info,
  LayoutDashboard,
  LoaderCircle,
  MemoryStick,
  Network,
  Play,
  Plus,
  RotateCcw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  BootstrapData,
  ConsoleEntry,
  CreateInstanceInput,
  InstanceView,
  ServerStatus,
  SetupProgress,
  UpdateInstanceInput
} from '../../shared/contracts'

type ViewName = 'overview' | 'console' | 'settings'
type Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string }

const statusLabels: Record<ServerStatus, string> = {
  offline: 'Offline',
  starting: 'Starting',
  online: 'Online',
  stopping: 'Stopping',
  crashed: 'Needs attention'
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^[A-Z_]+:\s*/, '')
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatUptime(startedAt: string | null, now: number): string {
  if (!startedAt) return '—'
  const total = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function StatusBadge({ status, large = false }: { status: ServerStatus; large?: boolean }): React.JSX.Element {
  const Icon = status === 'online' ? Check : status === 'crashed' ? AlertTriangle : status === 'offline' ? CircleStop : LoaderCircle
  return (
    <span className={`status-badge status-${status} ${large ? 'status-large' : ''}`} role="status">
      <Icon size={large ? 17 : 14} className={status === 'starting' || status === 'stopping' ? 'spin' : ''} />
      {statusLabels[status]}
    </span>
  )
}

function Toggle({ checked, onChange, label, description, disabled = false }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle" aria-hidden="true"><span /></span>
    </label>
  )
}

function MetricCard({ icon: Icon, label, value, detail, tone = 'green' }: {
  icon: React.ComponentType<{ size?: number }>
  label: string
  value: string
  detail: string
  tone?: 'green' | 'blue' | 'amber'
}): React.JSX.Element {
  return (
    <article className="metric-card">
      <span className={`metric-icon tone-${tone}`}><Icon size={19} /></span>
      <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </article>
  )
}

function LoadingScreen(): React.JSX.Element {
  return (
    <main className="loading-screen">
      <div className="brand-mark large"><span>E</span></div>
      <LoaderCircle className="spin" size={22} />
      <p>Preparing your control room…</p>
    </main>
  )
}

interface SetupProps {
  bootstrap: BootstrapData
  canClose: boolean
  progress: SetupProgress | null
  creating: boolean
  error: string | null
  onClose: () => void
  onRetryVersion: () => Promise<void>
  onCreate: (input: CreateInstanceInput) => Promise<void>
}

function CreateServerDialog({ bootstrap, canClose, progress, creating, error, onClose, onRetryVersion, onCreate }: SetupProps): React.JSX.Element {
  const safeMemoryCap = Math.max(1024, Math.floor((bootstrap.totalMemoryMb - 2048) / 512) * 512)
  const recommendedMemory = Math.min(4096, safeMemoryCap)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('My Minecraft Server')
  const [motd, setMotd] = useState('A world hosted with EmberHost')
  const [memoryMb, setMemoryMb] = useState(recommendedMemory)
  const [port, setPort] = useState(25565)
  const [maxPlayers, setMaxPlayers] = useState(20)
  const [javaPath, setJavaPath] = useState(bootstrap.java.command || 'java')
  const [eulaAccepted, setEulaAccepted] = useState(false)

  const stepValid = step === 0 ? name.trim().length > 0 && motd.trim().length > 0 : step === 1
    ? memoryMb >= 1024 && port >= 1024 && port <= 65535 && maxPlayers >= 1
    : eulaAccepted && bootstrap.latestVersion !== null

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (step < 2) {
      setStep((value) => value + 1)
      return
    }
    if (!eulaAccepted) return
    const version = bootstrap.latestVersion?.id
    if (!version) return
    await onCreate({ name: name.trim(), version, motd: motd.trim(), memoryMb, port, maxPlayers, javaPath, eulaAccepted: true })
  }

  return (
    <div className="dialog-backdrop">
      <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        {canClose && !creating && (
          <button className="icon-button dialog-close" onClick={onClose} aria-label="Close setup"><X size={18} /></button>
        )}
        <div className="setup-aside">
          <div className="brand"><div className="brand-mark"><span>E</span></div><div><strong>EmberHost</strong><small>Server manager</small></div></div>
          <div className="setup-copy">
            <span className="eyebrow"><Sparkles size={14} /> Quick setup</span>
            <h2 id="setup-title">Build a world that stays yours.</h2>
            <p>We’ll download a clean vanilla server directly from Mojang and keep it running from this computer.</p>
          </div>
          <ol className="step-list">
            {['Server basics', 'Performance & network', 'Review & create'].map((label, index) => (
              <li key={label} className={index === step ? 'active' : index < step ? 'complete' : ''}>
                <span>{index < step ? <Check size={14} /> : index + 1}</span>{label}
              </li>
            ))}
          </ol>
          <div className="local-note"><ShieldCheck size={16} /><span>Files stay on this computer. Online mode is enabled by default.</span></div>
        </div>

        <form className="setup-content" onSubmit={submit}>
          {!creating && step === 0 && (
            <div className="form-page">
              <div className="form-heading"><span>01</span><div><h3>Name your server</h3><p>You can change these details later.</p></div></div>
              <label className="field"><span>Server name</span><input autoFocus value={name} maxLength={48} onChange={(event) => setName(event.target.value)} placeholder="Weekend Realm" /></label>
              <label className="field"><span>Message of the day</span><input value={motd} maxLength={120} onChange={(event) => setMotd(event.target.value)} /></label>
              <div className="edition-card selected"><div className="edition-cube"><Server size={24} /></div><div><strong>Vanilla · Java Edition</strong><span>Latest stable release</span></div><span className="selected-check"><Check size={14} /></span></div>
              <div className="version-strip"><span>Version</span><strong>{bootstrap.latestVersion?.id ?? 'Unavailable'}</strong><small>{bootstrap.latestVersion ? `Requires Java ${bootstrap.latestVersion.requiredJavaVersion}` : bootstrap.versionLookupError}</small>{!bootstrap.latestVersion && <button type="button" onClick={() => void onRetryVersion()}><RotateCcw size={12} /> Retry lookup</button>}</div>
            </div>
          )}

          {!creating && step === 1 && (
            <div className="form-page">
              <div className="form-heading"><span>02</span><div><h3>Give it room to run</h3><p>Balanced defaults for this computer.</p></div></div>
              <label className="field range-field">
                <span>Maximum memory <strong>{(memoryMb / 1024).toFixed(memoryMb % 1024 ? 1 : 0)} GB</strong></span>
                <input type="range" min="1024" max={Math.max(1024, Math.min(16384, safeMemoryCap))} step="512" value={memoryMb} onChange={(event) => setMemoryMb(Number(event.target.value))} />
                <small>{Math.round(bootstrap.totalMemoryMb / 1024)} GB detected · {Math.round(memoryMb / bootstrap.totalMemoryMb * 100)}% allocated</small>
              </label>
              {bootstrap.totalMemoryMb < 4096 && <div className="info-callout warning"><AlertTriangle size={18} /><div><strong>This computer has limited memory.</strong><span>Leave other applications closed and begin with a small player count.</span></div></div>}
              <div className="field-grid">
                <label className="field"><span>Server port</span><input type="number" min="1024" max="65535" value={port} onChange={(event) => setPort(Number(event.target.value))} /><small>25565 is the Minecraft default</small></label>
                <label className="field"><span>Player limit</span><input type="number" min="1" max="1000" value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))} /></label>
              </div>
              <label className="field"><span>Java executable</span><input value={javaPath} maxLength={500} onChange={(event) => setJavaPath(event.target.value)} /><small>{bootstrap.java.available ? `${bootstrap.java.versionText} detected` : 'Java was not detected. Enter the full executable path.'}</small></label>
              <div className="info-callout"><Network size={18} /><div><strong>Starting locally is automatic.</strong><span>Public internet access may still need a firewall rule and router port forwarding. EmberHost will not change those without you.</span></div></div>
            </div>
          )}

          {!creating && step === 2 && (
            <div className="form-page">
              <div className="form-heading"><span>03</span><div><h3>Ready to create</h3><p>One last check before the download begins.</p></div></div>
              <div className="review-card">
                <div><span>Server</span><strong>{name}</strong></div><div><span>Release</span><strong>Minecraft {bootstrap.latestVersion?.id ?? '—'}</strong></div>
                <div><span>Memory</span><strong>{(memoryMb / 1024).toFixed(1)} GB</strong></div><div><span>Address</span><strong>localhost:{port}</strong></div>
                <div><span>Players</span><strong>Up to {maxPlayers}</strong></div><div><span>Authentication</span><strong>Online mode</strong></div>
              </div>
              <label className="eula-check">
                <input type="checkbox" checked={eulaAccepted} onChange={(event) => setEulaAccepted(event.target.checked)} />
                <span className="check-box">{eulaAccepted && <Check size={14} />}</span>
                <span>I have read and agree to the <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void window.emberHost.openEula() }}>Minecraft End User License Agreement <ExternalLink size={12} /></button>.</span>
              </label>
              <div className="info-callout neutral"><Info size={18} /><div><strong>The server JAR comes straight from Mojang.</strong><span>EmberHost verifies the official file before placing it in your private server folder.</span></div></div>
            </div>
          )}

          {creating && (
            <div className="creation-progress" aria-live="polite">
              <div className="progress-orbit"><div className="brand-mark large"><span>E</span></div><span /></div>
              <span className="eyebrow">Creating your server</span>
              <h3>{progress?.message ?? 'Preparing…'}</h3>
              <div className="progress-track"><span style={{ width: `${progress?.percent ?? 2}%` }} /></div>
              <div className="progress-meta"><strong>{progress?.percent ?? 2}%</strong><span>{progress?.bytesReceived && progress.totalBytes ? `${formatBytes(progress.bytesReceived)} of ${formatBytes(progress.totalBytes)}` : 'This can take a minute on the first run'}</span></div>
            </div>
          )}

          {error && <div className="form-error" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
          {!creating && (
            <div className="setup-actions">
              {step > 0 ? <button type="button" className="button secondary" onClick={() => setStep((value) => value - 1)}>Back</button> : <span />}
              <button type="submit" className="button primary" disabled={!stepValid}>
                {step === 2 ? <><HardDrive size={17} /> Download & create</> : <>Continue <ChevronRight size={17} /></>}
              </button>
            </div>
          )}
        </form>
      </section>
    </div>
  )
}

function Overview({ instance, address, logs, now, busy, onStartStop, onOpenFolder, onCopy, onConsole }: {
  instance: InstanceView
  address: string
  logs: ConsoleEntry[]
  now: number
  busy: boolean
  onStartStop: () => void
  onOpenFolder: () => void
  onCopy: () => void
  onConsole: () => void
}): React.JSX.Element {
  const active = instance.runtime.status === 'online' || instance.runtime.status === 'starting'
  const stopping = instance.runtime.status === 'stopping'
  return (
    <div className="page-content">
      <section className={`hero-card hero-${instance.runtime.status}`}>
        <div className="hero-glow" />
        <div className="hero-main">
          <StatusBadge status={instance.runtime.status} large />
          <h2>{instance.runtime.status === 'online' ? 'Your world is live.' : instance.runtime.status === 'starting' ? 'Warming up your world…' : stopping ? 'Saving and stopping…' : instance.runtime.status === 'crashed' ? 'The last run needs attention.' : 'Ready when you are.'}</h2>
          <p>{instance.runtime.status === 'online' ? 'Players on your network can connect with this address.' : instance.runtime.status === 'starting' ? 'Minecraft is loading the world and preparing the network.' : stopping ? 'Minecraft is saving the world before the Java process exits.' : 'Start the server to make this world available on your computer and local network.'}</p>
          <button className="address-pill" onClick={onCopy} title="Copy address"><Network size={16} /><span>{address}</span><Copy size={14} /></button>
        </div>
        <div className="hero-stats">
          <div><span>Uptime</span><strong>{instance.runtime.status === 'online' ? formatUptime(instance.runtime.startedAt, now) : '—'}</strong></div>
          <div><span>Players</span><strong>{instance.runtime.playerCount} / {instance.maxPlayers}</strong></div>
          <div><span>Process ID</span><strong>{instance.runtime.pid ?? '—'}</strong></div>
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard icon={MemoryStick} label="Memory limit" value={`${(instance.memoryMb / 1024).toFixed(instance.memoryMb % 1024 ? 1 : 0)} GB`} detail="Maximum Java heap" />
        <MetricCard icon={Users} label="Players online" value={`${instance.runtime.playerCount}`} detail={`${instance.maxPlayers} player slots`} tone="blue" />
        <MetricCard icon={Code2} label="Runtime" value={`Java ${instance.requiredJavaVersion}`} detail={`For Minecraft ${instance.version}`} tone="amber" />
      </section>

      <section className="dashboard-grid">
        <article className="panel activity-panel">
          <div className="panel-heading"><div><span className="panel-icon"><Activity size={17} /></span><div><h3>Recent activity</h3><p>Latest server events</p></div></div><button className="text-button" onClick={onConsole}>Full console <ChevronRight size={14} /></button></div>
          <div className="activity-list">
            {logs.slice(-5).reverse().map((entry) => (
              <div className="activity-row" key={entry.id}><span className={`activity-dot level-${entry.level}`} /><div><p>{entry.line}</p><span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div></div>
            ))}
            {!logs.length && <div className="empty-inline"><Clock3 size={22} /><div><strong>No activity yet</strong><span>Start the server and its events will appear here.</span></div></div>}
          </div>
        </article>
        <article className="panel quick-panel">
          <div className="panel-heading"><div><span className="panel-icon"><Gauge size={17} /></span><div><h3>Quick actions</h3><p>Common server tools</p></div></div></div>
          <button className="quick-action" onClick={onStartStop} disabled={busy || stopping}>
            <span className={active || stopping ? 'quick-stop' : 'quick-start'}>{busy || stopping ? <LoaderCircle className="spin" size={18} /> : active ? <CircleStop size={18} /> : <Play size={18} />}</span>
            <span><strong>{stopping ? 'Stopping server' : active ? 'Stop server' : 'Start server'}</strong><small>{stopping ? 'Saving the world safely' : active ? 'Saves the world first' : 'Launch this Minecraft world'}</small></span><ChevronRight size={16} />
          </button>
          <button className="quick-action" onClick={onConsole}><span><SquareTerminal size={18} /></span><span><strong>Open console</strong><small>View logs and run commands</small></span><ChevronRight size={16} /></button>
          <button className="quick-action" onClick={onOpenFolder}><span><FolderOpen size={18} /></span><span><strong>Server files</strong><small>Open this instance folder</small></span><ChevronRight size={16} /></button>
        </article>
      </section>

      <div className="network-banner"><ShieldCheck size={19} /><div><strong>Local-first by design</strong><span>EmberHost does not automatically expose your PC to the internet. Public hosting needs firewall and router configuration.</span></div></div>
    </div>
  )
}

function ConsoleView({ instance, logs, onSend }: {
  instance: InstanceView
  logs: ConsoleEntry[]
  onSend: (command: string) => Promise<void>
}): React.JSX.Element {
  const [command, setCommand] = useState('')
  const [clearedThrough, setClearedThrough] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const online = instance.runtime.status === 'online' || instance.runtime.status === 'starting'
  const visibleLogs = useMemo(() => {
    if (!clearedThrough) return logs
    const cutoff = logs.findIndex((entry) => entry.id === clearedThrough)
    return cutoff < 0 ? logs : logs.slice(cutoff + 1)
  }, [logs, clearedThrough])

  useEffect(() => {
    if (followLatest.current) viewport.current?.scrollTo({ top: viewport.current.scrollHeight })
  }, [visibleLogs])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const next = command.trim()
    if (!next || !online) return
    setCommand('')
    await onSend(next)
  }

  return (
    <div className="page-content console-page">
      <section className="console-shell">
        <div className="console-toolbar"><div><StatusBadge status={instance.runtime.status} /><span>{instance.name} console</span></div><button className="toolbar-button" onClick={() => setClearedThrough(logs.at(-1)?.id ?? null)}><Trash2 size={14} /> Clear view</button></div>
        <div className="console-viewport" ref={viewport} role="log" aria-live="polite" onScroll={(event) => { const element = event.currentTarget; followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36 }}>
          {visibleLogs.map((entry) => (
            <div className={`console-line console-${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time><span className="level-label">{entry.level}</span><code>{entry.line}</code></div>
          ))}
          {!visibleLogs.length && <div className="console-empty"><SquareTerminal size={28} /><strong>Console is quiet</strong><span>Start the server to see startup logs.</span></div>}
        </div>
        <form className="command-bar" onSubmit={submit}>
          <span>&gt;</span><input aria-label="Server command" value={command} onChange={(event) => setCommand(event.target.value)} disabled={!online} placeholder={online ? 'Enter a command, such as list' : 'Start the server to send commands'} />
          <button disabled={!online || !command.trim()}>Send</button>
        </form>
      </section>
      <div className="command-hints"><span>Try a command</span>{['list', 'time set day', 'weather clear', 'save-all'].map((hint) => <button key={hint} onClick={() => setCommand(hint)} disabled={!online}>{hint}</button>)}</div>
    </div>
  )
}

function SettingsView({ instance, appSettings, saving, appSettingsSaving, onSave, onAppSettings }: {
  instance: InstanceView
  appSettings: AppSettings
  saving: boolean
  appSettingsSaving: boolean
  onSave: (input: UpdateInstanceInput) => Promise<void>
  onAppSettings: (value: AppSettings) => void
}): React.JSX.Element {
  const [form, setForm] = useState<UpdateInstanceInput>(() => ({
    id: instance.id,
    name: instance.name,
    memoryMb: instance.memoryMb,
    port: instance.port,
    maxPlayers: instance.maxPlayers,
    motd: instance.motd,
    gameMode: instance.gameMode,
    difficulty: instance.difficulty,
    onlineMode: instance.onlineMode,
    viewDistance: instance.viewDistance,
    simulationDistance: instance.simulationDistance,
    javaPath: instance.javaPath
  }))

  useEffect(() => setForm({
    id: instance.id,
    name: instance.name,
    memoryMb: instance.memoryMb,
    port: instance.port,
    maxPlayers: instance.maxPlayers,
    motd: instance.motd,
    gameMode: instance.gameMode,
    difficulty: instance.difficulty,
    onlineMode: instance.onlineMode,
    viewDistance: instance.viewDistance,
    simulationDistance: instance.simulationDistance,
    javaPath: instance.javaPath
  }), [instance.id, instance.updatedAt])

  const update = <K extends keyof UpdateInstanceInput>(key: K, value: UpdateInstanceInput[K]): void => setForm((current) => ({ ...current, [key]: value }))
  const active = instance.runtime.status === 'online' || instance.runtime.status === 'starting' || instance.runtime.status === 'stopping'

  return (
    <form className="page-content settings-content" onSubmit={(event) => { event.preventDefault(); void onSave(form) }}>
      {active && <div className="settings-warning"><AlertTriangle size={17} /><span>Stop the server before saving configuration changes.</span></div>}
      <section className="settings-section">
        <div className="settings-title"><span><Server size={19} /></span><div><h3>Server identity</h3><p>The details players see when they connect.</p></div></div>
        <div className="settings-fields">
          <label className="field"><span>Server name</span><input value={form.name} maxLength={48} onChange={(event) => update('name', event.target.value)} /></label>
          <label className="field"><span>Message of the day</span><input value={form.motd} maxLength={120} onChange={(event) => update('motd', event.target.value)} /></label>
          <div className="field-grid three">
            <label className="field"><span>Game mode</span><select value={form.gameMode} onChange={(event) => update('gameMode', event.target.value as UpdateInstanceInput['gameMode'])}><option value="survival">Survival</option><option value="creative">Creative</option><option value="adventure">Adventure</option><option value="spectator">Spectator</option></select></label>
            <label className="field"><span>Difficulty</span><select value={form.difficulty} onChange={(event) => update('difficulty', event.target.value as UpdateInstanceInput['difficulty'])}><option value="peaceful">Peaceful</option><option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option></select></label>
            <label className="field"><span>Player limit</span><input type="number" min="1" max="1000" value={form.maxPlayers} onChange={(event) => update('maxPlayers', Number(event.target.value))} /></label>
          </div>
          <Toggle checked={form.onlineMode} onChange={(value) => update('onlineMode', value)} label="Online mode" description="Verify player accounts with Mojang. Strongly recommended." />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-title"><span><Gauge size={19} /></span><div><h3>Performance & network</h3><p>Changes take effect on the next start.</p></div></div>
        <div className="settings-fields">
          <div className="field-grid">
            <label className="field"><span>Memory (MB)</span><input type="number" min="1024" max="65536" step="512" value={form.memoryMb} onChange={(event) => update('memoryMb', Number(event.target.value))} /></label>
            <label className="field"><span>Server port</span><input type="number" min="1024" max="65535" value={form.port} onChange={(event) => update('port', Number(event.target.value))} /></label>
            <label className="field"><span>View distance</span><input type="number" min="2" max="32" value={form.viewDistance} onChange={(event) => update('viewDistance', Number(event.target.value))} /></label>
            <label className="field"><span>Simulation distance</span><input type="number" min="2" max="32" value={form.simulationDistance} onChange={(event) => update('simulationDistance', Number(event.target.value))} /></label>
          </div>
          <label className="field"><span>Java executable</span><input value={form.javaPath} maxLength={500} onChange={(event) => update('javaPath', event.target.value)} /><small>Minecraft {instance.version} expects Java {instance.requiredJavaVersion}.</small></label>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-title"><span><Settings size={19} /></span><div><h3>EmberHost behavior</h3><p>How the desktop app runs on this computer.</p></div></div>
        <div className="settings-fields toggle-stack">
          <Toggle checked={appSettings.minimizeToTray} disabled={appSettingsSaving} onChange={(value) => onAppSettings({ ...appSettings, minimizeToTray: value })} label="Keep running in the system tray" description="Closing the window hides it while servers keep running." />
          <Toggle checked={appSettings.launchAtLogin} disabled={appSettingsSaving} onChange={(value) => onAppSettings({ ...appSettings, launchAtLogin: value })} label="Launch EmberHost when I sign in" description="Available in packaged builds." />
        </div>
      </section>

      <div className="save-bar"><span>{active ? 'Configuration is locked while the server is active.' : 'Unknown server.properties entries will be preserved.'}</span><button className="button primary" disabled={saving || active}>{saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} Save changes</button></div>
    </form>
  )
}

export default function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [instances, setInstances] = useState<InstanceView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<ViewName>('overview')
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createProgress, setCreateProgress] = useState<SetupProgress | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, ConsoleEntry[]>>({})
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [appSettingsSaving, setAppSettingsSaving] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [now, setNow] = useState(Date.now())
  const [appSettings, setAppSettings] = useState<AppSettings>({ launchAtLogin: false, minimizeToTray: true })

  const selected = useMemo(() => instances.find((instance) => instance.id === selectedId) ?? instances[0] ?? null, [instances, selectedId])
  const selectedLogs = selected ? logs[selected.id] ?? [] : []
  const selectedActive = selected?.runtime.status === 'online' || selected?.runtime.status === 'starting'
  const selectedStopping = selected?.runtime.status === 'stopping'

  const toast = (kind: Toast['kind'], message: string): void => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, kind, message }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200)
  }

  const refreshLatestVersion = async (): Promise<void> => {
    try {
      const latestVersion = await window.emberHost.getLatestVersion()
      setBootstrap((current) => current ? { ...current, latestVersion, versionLookupError: null } : current)
      setCreateError(null)
    } catch (error) {
      const message = friendlyError(error)
      setBootstrap((current) => current ? { ...current, latestVersion: null, versionLookupError: message } : current)
      setCreateError(message)
    }
  }

  const openCreate = (): void => {
    setCreateError(null)
    setShowCreate(true)
    void refreshLatestVersion()
  }

  useEffect(() => {
    void window.emberHost.getBootstrap().then((data) => {
      setBootstrap(data)
      setInstances(data.instances)
      setSelectedId(data.instances[0]?.id ?? null)
      setAppSettings(data.settings)
      setShowCreate(data.instances.length === 0)
    }).catch((error) => setLoadError(friendlyError(error)))

    const removeProgress = window.emberHost.onSetupProgress(setCreateProgress)
    const removeConsole = window.emberHost.onConsoleEntry((entry) => setLogs((current) => {
      const next = [...(current[entry.instanceId] ?? []), entry]
      return { ...current, [entry.instanceId]: next.slice(-1000) }
    }))
    const removeState = window.emberHost.onStateChange((event) => setInstances((current) => current.map((instance) => instance.id === event.instanceId ? { ...instance, runtime: event.runtime } : instance)))
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { removeProgress(); removeConsole(); removeState(); window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!selected) return
    void window.emberHost.getLogs(selected.id).then((entries) => setLogs((current) => ({ ...current, [selected.id]: entries })))
  }, [selected?.id])

  const createInstance = async (input: CreateInstanceInput): Promise<void> => {
    setCreating(true)
    setCreateError(null)
    setCreateProgress({ phase: 'version', percent: 2, message: 'Preparing setup…' })
    try {
      const instance = await window.emberHost.createInstance(input)
      setInstances((current) => [...current, instance])
      setSelectedId(instance.id)
      setCreating(false)
      setShowCreate(false)
      setCreateProgress(null)
      setView('overview')
      toast('success', `${instance.name} is ready to start.`)
    } catch (error) {
      setCreating(false)
      setCreateError(friendlyError(error))
    }
  }

  const startStop = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    try {
      const active = selected.runtime.status === 'online' || selected.runtime.status === 'starting'
      const updated = active ? await window.emberHost.stopInstance(selected.id) : await window.emberHost.startInstance(selected.id)
      setInstances((current) => current.map((instance) => instance.id === updated.id ? updated : instance))
      toast('success', active ? 'Server stopped safely.' : 'Server startup has begun.')
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setBusy(false)
    }
  }

  const sendCommand = async (command: string): Promise<void> => {
    if (!selected) return
    try { await window.emberHost.sendCommand(selected.id, command) } catch (error) { toast('error', friendlyError(error)) }
  }

  const saveSettings = async (input: UpdateInstanceInput): Promise<void> => {
    setSaving(true)
    try {
      const updated = await window.emberHost.updateInstance(input)
      setInstances((current) => current.map((instance) => instance.id === updated.id ? updated : instance))
      toast('success', 'Server settings saved.')
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setSaving(false)
    }
  }

  const saveAppSettings = (next: AppSettings): void => {
    if (appSettingsSaving) return
    const previous = appSettings
    setAppSettings(next)
    setAppSettingsSaving(true)
    void window.emberHost.updateAppSettings(next).then((saved) => {
      setAppSettings(saved)
      toast('success', 'EmberHost behavior updated.')
    }).catch((error) => {
      setAppSettings(previous)
      toast('error', friendlyError(error))
    }).finally(() => setAppSettingsSaving(false))
  }

  if (loadError) return <main className="fatal-screen"><AlertTriangle size={32} /><h1>EmberHost could not start</h1><p>{loadError}</p><button className="button secondary" onClick={() => location.reload()}><RotateCcw size={16} /> Try again</button></main>
  if (!bootstrap) return <LoadingScreen />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><span>E</span></div><div><strong>EmberHost</strong><small>Server manager</small></div></div>
        <div className="instance-select-wrap"><span>Active server</span><select aria-label="Active server" value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)} disabled={!instances.length}>{instances.length ? instances.map((instance) => <option value={instance.id} key={instance.id}>{instance.name}</option>) : <option>No server yet</option>}</select></div>
        <nav aria-label="Main navigation">
          <span>Workspace</span>
          <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><LayoutDashboard size={18} /> Overview</button>
          <button className={view === 'console' ? 'active' : ''} onClick={() => setView('console')}><SquareTerminal size={18} /> Console {selectedLogs.some((entry) => entry.level === 'error') && <i />}</button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Settings size={18} /> Settings</button>
        </nav>
        <div className="sidebar-spacer" />
        <button className="new-server-side" onClick={openCreate}><Plus size={17} /> New server</button>
        {selected && <div className="sidebar-status"><div><span className={`status-dot status-${selected.runtime.status}`} /><div><strong>{selected.name}</strong><small>{statusLabels[selected.runtime.status]} · :{selected.port}</small></div></div><Server size={18} /></div>}
        <div className="app-version">EmberHost v{bootstrap.appVersion}</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div><span className="eyebrow">{view === 'overview' ? 'Server workspace' : view === 'console' ? 'Live operations' : 'Configuration'}</span><h1>{view === 'overview' ? selected?.name ?? 'Your server' : view === 'console' ? 'Console' : 'Settings'}</h1></div>
          <div className="topbar-actions">
            {selected && <StatusBadge status={selected.runtime.status} />}
            {selected && <button className="icon-button" title="Open server folder" aria-label="Open server folder" onClick={() => void window.emberHost.openServerFolder(selected.id).catch((error) => toast('error', friendlyError(error)))}><FolderOpen size={18} /></button>}
            <button className="button secondary compact" onClick={openCreate}><Plus size={16} /> New server</button>
            {selected && <button className={`button compact ${selectedActive || selectedStopping ? 'danger' : 'primary'}`} disabled={busy || selectedStopping} onClick={() => void startStop()}>{busy || selectedStopping ? <LoaderCircle className="spin" size={16} /> : selectedActive ? <CircleStop size={16} /> : <Play size={16} />}{selectedStopping ? 'Stopping' : selectedActive ? 'Stop' : 'Start'}</button>}
          </div>
        </header>

        {selected ? (
          view === 'overview' ? <Overview instance={selected} address={`${bootstrap.lanAddresses[0] ?? 'localhost'}:${selected.port}`} logs={selectedLogs} now={now} busy={busy} onStartStop={() => void startStop()} onOpenFolder={() => void window.emberHost.openServerFolder(selected.id).catch((error) => toast('error', friendlyError(error)))} onCopy={() => { void navigator.clipboard.writeText(`${bootstrap.lanAddresses[0] ?? 'localhost'}:${selected.port}`).then(() => toast('info', 'Server address copied.')).catch((error) => toast('error', friendlyError(error))) }} onConsole={() => setView('console')} />
            : view === 'console' ? <ConsoleView key={selected.id} instance={selected} logs={selectedLogs} onSend={sendCommand} />
              : <SettingsView instance={selected} appSettings={appSettings} saving={saving} appSettingsSaving={appSettingsSaving} onSave={saveSettings} onAppSettings={saveAppSettings} />
        ) : <div className="empty-workspace"><div className="brand-mark large"><span>E</span></div><h2>Create your first server</h2><p>EmberHost will download the newest vanilla release and set it up on this computer.</p><button className="button primary" onClick={openCreate}><Plus size={17} /> Create a server</button></div>}
      </main>

      {showCreate && <CreateServerDialog bootstrap={bootstrap} canClose={instances.length > 0} progress={createProgress} creating={creating} error={createError} onClose={() => setShowCreate(false)} onRetryVersion={refreshLatestVersion} onCreate={createInstance} />}
      <div className="toast-region" aria-live="polite">{toasts.map((item) => <div key={item.id} className={`toast toast-${item.kind}`}>{item.kind === 'error' ? <AlertTriangle size={17} /> : item.kind === 'success' ? <Check size={17} /> : <Clipboard size={17} />}<span>{item.message}</span></div>)}</div>
    </div>
  )
}
