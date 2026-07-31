import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  CirclePause,
  CirclePlay,
  CircleStop,
  Clipboard,
  Clock3,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  FolderOpen,
  Gauge,
  Globe2,
  HardDrive,
  Info,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Map,
  MemoryStick,
  Network,
  OctagonX,
  PackagePlus,
  Play,
  Plus,
  Puzzle,
  Radius,
  RotateCcw,
  Rocket,
  Save,
  Search,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Users,
  WandSparkles,
  Zap,
  X
} from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  BootstrapData,
  CatalogPaperPlugin,
  CatalogPluginInstallInput,
  ConsoleEntry,
  CreateInstanceInput,
  ForceLoadedRegionsState,
  InstanceView,
  LatestVersion,
  MinecraftReleaseInfo,
  PaperBuildInfo,
  PaperPluginInfo,
  PerformancePreset,
  ServerSoftwareSelection,
  ServerStatus,
  SetupProgress,
  UpdateInstanceInput,
  WorldDimension,
  WorldPreparationState
} from '../../shared/contracts'
import { PERFORMANCE_PROFILES, matchingPerformancePreset, profileValues } from '../../shared/performance'

type ViewName = 'overview' | 'world' | 'plugins' | 'console' | 'settings'
type Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string }

type PaperCreateInput = CreateInstanceInput & {
  software: ServerSoftwareSelection
  performancePreset: Exclude<PerformancePreset, 'custom'>
}

type PaperApi = typeof window.emberHost

const presetIds: Array<Exclude<PerformancePreset, 'custom'>> = ['balanced', 'far-view', 'maximum-performance']

const presetOptions: Array<{
  id: Exclude<PerformancePreset, 'custom'>
  label: string
  description: string
  detail: string
}> = presetIds.map((id) => {
  const profile = PERFORMANCE_PROFILES[id]
  return {
    id,
    label: id === 'far-view' ? 'Far View' : id === 'maximum-performance' ? 'Maximum Performance' : profile.title,
    description: profile.description,
    detail: `${profile.viewDistance} view · ${profile.simulationDistance} simulation`
  }
})

const dimensionLabels: Record<WorldDimension, string> = {
  overworld: 'Overworld',
  nether: 'Nether',
  end: 'The End'
}

function instanceSoftware(instance: InstanceView): ServerSoftwareSelection {
  return instance.software
}

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

function categoryLabel(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
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
  tone?: 'green' | 'blue' | 'amber' | 'red' | 'neutral'
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
  onCreate: (input: PaperCreateInput) => Promise<void>
}

function CreateServerDialog({ bootstrap, canClose, progress, creating, error, onClose, onCreate }: SetupProps): React.JSX.Element {
  const safeMemoryCap = Math.max(1024, Math.floor((bootstrap.totalMemoryMb - 2048) / 512) * 512)
  const recommendedMemory = Math.min(profileValues('balanced', bootstrap.totalMemoryMb).memoryMb, safeMemoryCap)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('My Minecraft Server')
  const [motd, setMotd] = useState('A world hosted with EmberHost')
  const [memoryMb, setMemoryMb] = useState(recommendedMemory)
  const [port, setPort] = useState(25565)
  const [maxPlayers, setMaxPlayers] = useState(20)
  const [javaPath, setJavaPath] = useState(bootstrap.java.command || 'java')
  const [eulaAccepted, setEulaAccepted] = useState(false)
  const [software, setSoftware] = useState<'paper' | 'vanilla'>('paper')
  const [performancePreset, setPerformancePreset] = useState<Exclude<PerformancePreset, 'custom'>>('balanced')
  const [releases, setReleases] = useState<MinecraftReleaseInfo[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState(bootstrap.latestVersion?.id ?? '')
  const [selectedVersion, setSelectedVersion] = useState<LatestVersion | null>(bootstrap.latestVersion)
  const [paperBuild, setPaperBuild] = useState<PaperBuildInfo | null>(bootstrap.latestPaperBuild)
  const [releaseListError, setReleaseListError] = useState<string | null>(null)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [paperError, setPaperError] = useState<string | null>(bootstrap.paperLookupError)
  const [versionLoading, setVersionLoading] = useState(false)
  const releaseRequest = useRef(0)

  const loadReleases = async (): Promise<void> => {
    setReleaseListError(null)
    try {
      const result = await window.emberHost.getMinecraftReleases()
      setReleases(result)
      if (!selectedVersionId && result[0]) setSelectedVersionId(result[0].id)
    } catch (lookupError) {
      setReleaseListError(friendlyError(lookupError))
    }
  }

  const loadSelectedRelease = async (id: string): Promise<void> => {
    if (!id) return
    const request = ++releaseRequest.current
    setVersionLoading(true)
    setSelectedVersion(null)
    setReleaseError(null)
    setPaperError(null)
    setPaperBuild(null)
    try {
      const release = await window.emberHost.getMinecraftRelease(id)
      if (request !== releaseRequest.current) return
      setSelectedVersion(release)
      setVersionLoading(false)
      try {
        const build = await window.emberHost.getLatestPaperBuild(id)
        if (request !== releaseRequest.current) return
        setPaperBuild(build)
      } catch (lookupError) {
        if (request !== releaseRequest.current) return
        setPaperError(friendlyError(lookupError))
        setSoftware('vanilla')
      }
    } catch (lookupError) {
      if (request !== releaseRequest.current) return
      setSelectedVersion(null)
      setReleaseError(friendlyError(lookupError))
      setSoftware('vanilla')
    } finally {
      if (request === releaseRequest.current) setVersionLoading(false)
    }
  }

  useEffect(() => { void loadReleases() }, [])
  useEffect(() => { void loadSelectedRelease(selectedVersionId) }, [selectedVersionId])

  const softwareReady = software === 'vanilla' || paperBuild !== null && paperBuild !== undefined
  const stepValid = step === 0 ? name.trim().length > 0 && motd.trim().length > 0 && softwareReady && selectedVersion !== null && !versionLoading : step === 1
    ? memoryMb >= 1024 && port >= 1024 && port <= 65535 && maxPlayers >= 1
    : eulaAccepted && selectedVersion !== null

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (step < 2) {
      setStep((value) => value + 1)
      return
    }
    if (!eulaAccepted) return
    const version = selectedVersion?.id
    if (!version) return
    const selectedSoftware: ServerSoftwareSelection = software === 'paper' && paperBuild
      ? { kind: 'paper', build: paperBuild.build }
      : { kind: 'vanilla' }
    await onCreate({
      name: name.trim(),
      version,
      software: selectedSoftware,
      performancePreset,
      motd: motd.trim(),
      memoryMb,
      port,
      maxPlayers,
      javaPath,
      eulaAccepted: true
    })
  }

  const selectPreset = (preset: Exclude<PerformancePreset, 'custom'>): void => {
    setPerformancePreset(preset)
    setMemoryMb(Math.min(profileValues(preset, bootstrap.totalMemoryMb).memoryMb, safeMemoryCap))
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
            <p>Choose optimized Paper or official Vanilla, then keep the whole world running from this computer.</p>
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
              <fieldset className="choice-fieldset software-choices">
                <legend>Server software</legend>
                <label className={`choice-card software-card ${software === 'paper' ? 'selected' : ''} ${!paperBuild || versionLoading ? 'disabled' : ''}`}>
                  <input type="radio" name="software" value="paper" checked={software === 'paper'} disabled={!paperBuild || versionLoading} onChange={() => setSoftware('paper')} />
                  <span className="choice-icon"><Rocket size={20} /></span>
                  <span className="choice-copy"><strong>Paper</strong><small>Faster, configurable, plugin-ready</small></span>
                  <span className="recommended-tag">Recommended</span>
                  <span className="choice-check" aria-hidden="true">{software === 'paper' && <Check size={13} />}</span>
                </label>
                <label className={`choice-card software-card ${software === 'vanilla' ? 'selected' : ''}`}>
                  <input type="radio" name="software" value="vanilla" checked={software === 'vanilla'} onChange={() => setSoftware('vanilla')} />
                  <span className="choice-icon vanilla"><Server size={20} /></span>
                  <span className="choice-copy"><strong>Vanilla</strong><small>Official, unchanged Minecraft</small></span>
                  <span className="choice-check" aria-hidden="true">{software === 'vanilla' && <Check size={13} />}</span>
                </label>
              </fieldset>
              <div className="release-picker">
                <label className="field">
                  <span>Minecraft release <strong>{selectedVersionId === bootstrap.latestVersion?.id ? 'Latest' : 'Official release'}</strong></span>
                  <select aria-label="Minecraft release" value={selectedVersionId} disabled={creating || !selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>
                    {!releases.length && selectedVersionId && <option value={selectedVersionId}>{selectedVersionId}</option>}
                    {releases.map((release) => <option value={release.id} key={release.id}>{release.id}{release.id === bootstrap.latestVersion?.id ? ' — Latest' : ''}</option>)}
                  </select>
                </label>
                <div className={`version-strip ${releaseError ? 'version-error' : ''}`}>
                  <span>{versionLoading ? 'Checking release' : releaseError ? 'Unavailable' : 'Selected release'}</span>
                  <strong>{versionLoading ? 'Reading Mojang metadata…' : `Minecraft ${selectedVersion?.id ?? (selectedVersionId || 'Unavailable')}`}</strong>
                  <small>{releaseError ?? (selectedVersion
                    ? software === 'paper' && paperBuild
                      ? `Paper build ${paperBuild.build} · Requires Java ${selectedVersion.requiredJavaVersion}`
                      : `Official Mojang server · Requires Java ${selectedVersion.requiredJavaVersion}`
                    : bootstrap.versionLookupError ?? 'Choose an official release.')}</small>
                  {(releaseError || releaseListError) && <button type="button" onClick={() => { void loadReleases(); void loadSelectedRelease(selectedVersionId) }}><RotateCcw size={12} /> Retry lookup</button>}
                </div>
                {releaseListError && <div className="info-callout warning"><AlertTriangle size={17} /><div><strong>The release list could not refresh.</strong><span>{releaseListError}</span></div></div>}
                {!versionLoading && paperError && software === 'vanilla' && <div className="info-callout neutral"><Info size={17} /><div><strong>Paper is not available for this release.</strong><span>Vanilla remains available. {paperError}</span></div></div>}
              </div>
            </div>
          )}

          {!creating && step === 1 && (
            <div className="form-page">
              <div className="form-heading"><span>02</span><div><h3>Shape performance</h3><p>Start with a tuned profile and adjust it any time.</p></div></div>
              <fieldset className="choice-fieldset preset-choices">
                <legend>Performance preset</legend>
                {presetOptions.map((preset) => (
                  <label className={`choice-card preset-card ${performancePreset === preset.id ? 'selected' : ''}`} key={preset.id}>
                    <input type="radio" name="performance-preset" value={preset.id} checked={performancePreset === preset.id} onChange={() => selectPreset(preset.id)} />
                    <span className="choice-copy"><strong>{preset.label}</strong><small>{preset.description}</small><em>{preset.detail}</em></span>
                    <span className="choice-check" aria-hidden="true">{performancePreset === preset.id && <Check size={12} />}</span>
                  </label>
                ))}
              </fieldset>
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
              <label className="field"><span>Java executable</span><input value={javaPath} maxLength={500} onChange={(event) => setJavaPath(event.target.value)} /><small>{selectedVersion ? `Minecraft ${selectedVersion.id} expects Java ${selectedVersion.requiredJavaVersion}. ` : ''}{bootstrap.java.available ? `${bootstrap.java.versionText} detected.` : 'Java was not detected. Enter the full executable path.'}</small></label>
              <div className="info-callout"><Network size={18} /><div><strong>Starting locally is automatic.</strong><span>Public internet access may still need a firewall rule and router port forwarding. EmberHost will not change those without you.</span></div></div>
            </div>
          )}

          {!creating && step === 2 && (
            <div className="form-page">
              <div className="form-heading"><span>03</span><div><h3>Ready to create</h3><p>One last check before the download begins.</p></div></div>
              <div className="review-card">
                <div><span>Server</span><strong>{name}</strong></div><div><span>Software</span><strong>{software === 'paper' ? `Paper build ${paperBuild?.build ?? '—'}` : 'Vanilla'}</strong></div>
                <div><span>Release</span><strong>Minecraft {selectedVersion?.id ?? '—'}</strong></div><div><span>Profile</span><strong>{presetOptions.find((preset) => preset.id === performancePreset)?.label}</strong></div>
                <div><span>Memory</span><strong>{(memoryMb / 1024).toFixed(1)} GB</strong></div><div><span>Address</span><strong>localhost:{port}</strong></div>
                <div><span>Players</span><strong>Up to {maxPlayers}</strong></div><div><span>Authentication</span><strong>Online mode</strong></div>
              </div>
              <label className="eula-check">
                <input type="checkbox" checked={eulaAccepted} onChange={(event) => setEulaAccepted(event.target.checked)} />
                <span className="check-box">{eulaAccepted && <Check size={14} />}</span>
                <span>I have read and agree to the <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void window.emberHost.openEula() }}>Minecraft End User License Agreement <ExternalLink size={12} /></button>.</span>
              </label>
              <div className="info-callout neutral"><Info size={18} /><div><strong>{software === 'paper' ? 'Paper is built from Mojang’s official server.' : 'The server JAR comes straight from Mojang.'}</strong><span>{software === 'paper' ? 'EmberHost downloads the selected build from PaperMC and verifies it before setup.' : 'EmberHost verifies the official file before placing it in your private server folder.'}</span></div></div>
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

function healthTone(value: number | null, healthy: number, warning: number, lowerIsBetter = false): 'green' | 'amber' | 'red' | 'neutral' {
  if (value === null) return 'neutral'
  if (lowerIsBetter) return value <= healthy ? 'green' : value <= warning ? 'amber' : 'red'
  return value >= healthy ? 'green' : value >= warning ? 'amber' : 'red'
}

function Overview({ instance, address, logs, now, busy, onStartStop, onOpenFolder, onCopy, onConsole, onWorld }: {
  instance: InstanceView
  address: string
  logs: ConsoleEntry[]
  now: number
  busy: boolean
  onStartStop: () => void
  onOpenFolder: () => void
  onCopy: () => void
  onConsole: () => void
  onWorld: () => void
}): React.JSX.Element {
  const active = instance.runtime.status === 'online' || instance.runtime.status === 'starting'
  const stopping = instance.runtime.status === 'stopping'
  const paper = instanceSoftware(instance).kind === 'paper'
  const health = instance.runtime.health
  const memoryUsed = health.memoryUsedMb
  const memoryMax = health.memoryMaxMb ?? instance.memoryMb
  const memoryPercent = memoryUsed === null || memoryMax <= 0 ? null : memoryUsed / memoryMax * 100
  return (
    <div className="page-content">
      <section className={`hero-card hero-${instance.runtime.status}`}>
        <div className="hero-glow" />
        <div className="hero-main">
          <div className="hero-badges"><StatusBadge status={instance.runtime.status} large /><span className={`software-badge ${paper ? 'paper' : 'vanilla'}`}>{paper ? <Rocket size={13} /> : <Server size={13} />}{paper ? `Paper build ${instance.software.kind === 'paper' ? instance.software.build : ''}` : 'Vanilla'}</span></div>
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

      {paper ? (
        <section className="metric-grid paper-health-grid" aria-label="Paper server health">
          <MetricCard icon={Activity} label="Ticks per second" value={health.tps === null ? '—' : health.tps.toFixed(1)} detail={instance.runtime.status === 'online' ? '20 TPS is healthy' : 'Available while online'} tone={healthTone(health.tps, 18, 15)} />
          <MetricCard icon={Zap} label="Tick time" value={health.mspt === null ? '—' : `${health.mspt.toFixed(1)} ms`} detail="Below 50 ms is healthy" tone={healthTone(health.mspt, 40, 50, true)} />
          <MetricCard icon={MemoryStick} label="Process memory" value={memoryUsed === null ? '—' : `${(memoryUsed / 1024).toFixed(1)} GB`} detail={memoryPercent === null ? `${(instance.memoryMb / 1024).toFixed(1)} GB configured limit` : `${Math.round(memoryPercent)}% of configured limit`} tone={healthTone(memoryPercent, 72, 88, true)} />
          <MetricCard icon={Cpu} label="CPU load" value={health.cpuPercent === null ? '—' : `${Math.round(health.cpuPercent)}%`} detail="Minecraft process" tone={healthTone(health.cpuPercent, 65, 85, true)} />
        </section>
      ) : (
        <section className="metric-grid">
          <MetricCard icon={MemoryStick} label="Memory limit" value={`${(instance.memoryMb / 1024).toFixed(instance.memoryMb % 1024 ? 1 : 0)} GB`} detail="Maximum Java heap" />
          <MetricCard icon={Users} label="Players online" value={`${instance.runtime.playerCount}`} detail={`${instance.maxPlayers} player slots`} tone="blue" />
          <MetricCard icon={Code2} label="Runtime" value={`Java ${instance.requiredJavaVersion}`} detail={`For Minecraft ${instance.version}`} tone="amber" />
        </section>
      )}

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
          <button className="quick-action" onClick={onWorld}><span><Map size={18} /></span><span><strong>World tools</strong><small>{paper ? 'Prepare terrain and manage loaded regions' : 'See Paper-only world features'}</small></span><ChevronRight size={16} /></button>
          <button className="quick-action" onClick={onConsole}><span><SquareTerminal size={18} /></span><span><strong>Open console</strong><small>View logs and run commands</small></span><ChevronRight size={16} /></button>
          <button className="quick-action" onClick={onOpenFolder}><span><FolderOpen size={18} /></span><span><strong>Server files</strong><small>Open this instance folder</small></span><ChevronRight size={16} /></button>
        </article>
      </section>

      <div className="network-banner"><ShieldCheck size={19} /><div><strong>Local-first by design</strong><span>EmberHost does not automatically expose your PC to the internet. Public hosting needs firewall and router configuration.</span></div></div>
    </div>
  )
}

function emptyWorldPreparation(instanceId: string): WorldPreparationState {
  return {
    instanceId,
    status: 'idle',
    radius: 0,
    dimensions: [],
    currentDimension: null,
    completedChunks: 0,
    totalChunks: 0,
    percent: 0,
    rateCps: null,
    message: null,
    error: null,
    autoPaused: false
  }
}

function emptyForceLoadedRegions(instanceId: string): ForceLoadedRegionsState {
  return { instanceId, regions: [], maxRegions: 8, maxRadius: 7, maxTotalChunks: 256, totalChunks: 0 }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function WorldToolsView({
  instance,
  preparation,
  forceLoads,
  busy,
  onStartPreparation,
  onPausePreparation,
  onResumePreparation,
  onCancelPreparation,
  onAddForceLoad,
  onRemoveForceLoad,
  onCreatePaper
}: {
  instance: InstanceView
  preparation: WorldPreparationState
  forceLoads: ForceLoadedRegionsState
  busy: boolean
  onStartPreparation: (input: { radius: number; dimensions: WorldDimension[] }) => void
  onPausePreparation: () => void
  onResumePreparation: () => void
  onCancelPreparation: () => void
  onAddForceLoad: (input: { dimension: WorldDimension; centerX: number; centerZ: number; radius: number }) => void
  onRemoveForceLoad: (regionId: string) => void
  onCreatePaper: () => void
}): React.JSX.Element {
  const paper = instanceSoftware(instance).kind === 'paper'
  const online = instance.runtime.status === 'online'
  const playersConnected = instance.runtime.playerCount > 0
  const [radius, setRadius] = useState(5000)
  const [dimensions, setDimensions] = useState<WorldDimension[]>(['overworld'])
  const [forceDimension, setForceDimension] = useState<WorldDimension>('overworld')
  const [centerX, setCenterX] = useState(0)
  const [centerZ, setCenterZ] = useState(0)
  const [forceRadius, setForceRadius] = useState(1)

  const preparing = preparation.status === 'running' || preparation.status === 'paused'
  const estimatedSide = Math.ceil(radius / 16) * 2 + 1
  const estimatedChunks = estimatedSide * estimatedSide * dimensions.length
  const projectedForceChunks = (forceRadius * 2 + 1) ** 2
  const forceLimitReached = forceLoads.regions.length >= forceLoads.maxRegions || forceLoads.totalChunks + projectedForceChunks > forceLoads.maxTotalChunks
  const forcePressure = forceLoads.maxTotalChunks ? forceLoads.totalChunks / forceLoads.maxTotalChunks : 0

  const toggleDimension = (dimension: WorldDimension): void => {
    setDimensions((current) => current.includes(dimension) ? current.filter((value) => value !== dimension) : [...current, dimension])
  }

  return (
    <div className="page-content world-content">
      {!paper && (
        <section className="paper-gate" role="note">
          <div className="paper-gate-icon"><Rocket size={25} /></div>
          <div><span className="eyebrow">Paper feature set</span><h2>World tools need a Paper server.</h2><p>This Vanilla world stays fully supported for normal hosting. Create a Paper server to pre-generate terrain, monitor tick health, and safely bound force-loaded regions.</p></div>
          <button className="button primary" onClick={onCreatePaper}><Plus size={16} /> New Paper server</button>
        </section>
      )}

      <section className={`world-panel preparation-panel ${!paper ? 'paper-disabled' : ''}`} aria-labelledby="preparation-title" aria-disabled={!paper}>
        <div className="world-panel-heading">
          <div><span className="panel-icon"><WandSparkles size={18} /></span><div><h2 id="preparation-title">World Preparation</h2><p>Generate terrain before players explore it to prevent travel-time lag.</p></div></div>
          <span className={`tool-status tool-${preparation.status}`}>{preparation.status === 'idle' ? 'Not started' : preparation.status.replace('-', ' ')}</span>
        </div>

        {preparing ? (
          <div className="preparation-progress-wrap">
            <div className="preparation-summary">
              <div className="progress-ring" style={{ '--progress': `${Math.max(0, Math.min(100, preparation.percent)) * 3.6}deg` } as React.CSSProperties}><span>{Math.round(preparation.percent)}%</span></div>
              <div><span className="eyebrow">{preparation.currentDimension ? dimensionLabels[preparation.currentDimension] : preparation.status === 'completed' ? 'Preparation complete' : 'Preparing terrain'}</span><h3>{preparation.message ?? (preparation.status === 'paused' ? 'World preparation is paused.' : preparation.status === 'completed' ? 'The selected terrain is ready.' : 'Paper is generating chunks in the background.')}</h3><p>{formatCount(preparation.completedChunks)} of {formatCount(preparation.totalChunks)} chunks · {preparation.radius.toLocaleString()} block radius{preparation.rateCps !== null ? ` · ${preparation.rateCps.toFixed(1)} chunks/sec` : ''}</p></div>
            </div>
            <div className="wide-progress" role="progressbar" aria-label="World preparation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(preparation.percent)}><span style={{ width: `${Math.max(0, Math.min(100, preparation.percent))}%` }} /></div>
            {preparation.autoPaused && <div className="tool-callout amber"><CirclePause size={17} /><div><strong>Automatically paused to protect live play.</strong><span>Preparation will resume when the server has enough tick-time headroom.</span></div></div>}
            {preparation.error && <div className="tool-callout danger" role="alert"><AlertTriangle size={17} /><div><strong>Preparation stopped.</strong><span>{preparation.error}</span></div></div>}
            <div className="tool-actions">
              {preparation.status === 'running' && <button className="button secondary compact" disabled={busy} onClick={onPausePreparation}><CirclePause size={15} /> Pause</button>}
              {preparation.status === 'paused' && <button className="button primary compact" disabled={busy || !online} onClick={onResumePreparation}><CirclePlay size={15} /> Resume</button>}
              {preparing && <button className="button danger compact" disabled={busy} onClick={onCancelPreparation}><OctagonX size={15} /> Cancel</button>}
            </div>
          </div>
        ) : (
          <div className="preparation-config">
            <div className="preparation-form">
              {preparation.status === 'completed' && <div className="tool-callout success"><Check size={17} /><div><strong>Last preparation completed.</strong><span>{formatCount(preparation.completedChunks)} chunks are ready across {preparation.dimensions.map((dimension) => dimensionLabels[dimension]).join(', ')}.</span></div></div>}
              {preparation.status === 'failed' && <div className="tool-callout danger" role="alert"><AlertTriangle size={17} /><div><strong>Last preparation could not finish.</strong><span>{preparation.error ?? 'Review the console, adjust the area, and try again.'}</span></div></div>}
              {preparation.status === 'cancelled' && <div className="tool-callout amber"><Info size={17} /><div><strong>Last preparation was cancelled safely.</strong><span>Chunks already generated were kept. You can prepare a different area below.</span></div></div>}
              <label className="field"><span>Radius from spawn <strong>{radius.toLocaleString()} blocks</strong></span><input type="range" min="256" max="20000" step="256" value={radius} disabled={!paper || busy} onChange={(event) => setRadius(Number(event.target.value))} /><small>About {formatCount(estimatedChunks)} chunks across the selected dimensions.</small></label>
              <fieldset className="dimension-picker"><legend>Dimensions</legend>{(Object.keys(dimensionLabels) as WorldDimension[]).map((dimension) => <label key={dimension}><input type="checkbox" checked={dimensions.includes(dimension)} disabled={!paper || busy} onChange={() => toggleDimension(dimension)} /><span>{dimension === 'overworld' ? <Globe2 size={16} /> : dimension === 'nether' ? <Zap size={16} /> : <Sparkles size={16} />}{dimensionLabels[dimension]}</span></label>)}</fieldset>
            </div>
            <aside className="preparation-estimate"><span><Layers3 size={18} /> Estimated work</span><strong>{formatCount(estimatedChunks)} chunks</strong><p>EmberHost takes a safety backup first. Paper then prepares chunks incrementally and can pause automatically for live play.</p><button className="button primary" disabled={!paper || !online || playersConnected || busy || dimensions.length === 0} onClick={() => onStartPreparation({ radius, dimensions })}>{busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} Start preparation</button>{paper && !online && <small>Start the server before preparing terrain.</small>}{paper && online && playersConnected && <small>Wait until all players disconnect to take the safety backup.</small>}</aside>
          </div>
        )}
      </section>

      <section className={`world-panel force-panel ${!paper ? 'paper-disabled' : ''}`} aria-labelledby="force-title" aria-disabled={!paper}>
        <div className="world-panel-heading">
          <div><span className="panel-icon amber"><Radius size={18} /></span><div><h2 id="force-title">Force-loaded Regions</h2><p>Keep a small set of important chunks ticking without a nearby player.</p></div></div>
          <span className={`capacity-pill ${forcePressure >= .75 ? 'warning' : ''}`}>{forceLoads.totalChunks} / {forceLoads.maxTotalChunks} chunks</span>
        </div>

        <div className="tool-callout amber"><ShieldAlert size={17} /><div><strong>Force-loaded chunks always consume tick time.</strong><span>Use the smallest radius possible. EmberHost caps both region count and total loaded chunks to protect server health.</span></div></div>

        <div className="force-layout">
          <div className="force-form">
            <div className="field-grid three">
              <label className="field"><span>Dimension</span><select value={forceDimension} disabled={!paper || busy} onChange={(event) => setForceDimension(event.target.value as WorldDimension)}>{(Object.keys(dimensionLabels) as WorldDimension[]).map((dimension) => <option value={dimension} key={dimension}>{dimensionLabels[dimension]}</option>)}</select></label>
              <label className="field"><span>Center X (block)</span><input type="number" value={centerX} disabled={!paper || busy} onChange={(event) => setCenterX(Number(event.target.value))} /></label>
              <label className="field"><span>Center Z (block)</span><input type="number" value={centerZ} disabled={!paper || busy} onChange={(event) => setCenterZ(Number(event.target.value))} /></label>
            </div>
            <label className="field force-radius"><span>Radius <strong>{forceRadius} chunk{forceRadius === 1 ? '' : 's'}</strong></span><input type="range" min="1" max={Math.max(1, forceLoads.maxRadius)} step="1" value={Math.max(1, Math.min(forceRadius, forceLoads.maxRadius))} disabled={!paper || busy} onChange={(event) => setForceRadius(Number(event.target.value))} /><small>This square keeps {projectedForceChunks} chunk{projectedForceChunks === 1 ? '' : 's'} active around the block-coordinate center.</small></label>
            <button className="button secondary" disabled={!paper || !online || busy || forceLimitReached} onClick={() => onAddForceLoad({ dimension: forceDimension, centerX, centerZ, radius: forceRadius })}><Plus size={16} /> Add bounded region</button>
            {forceLimitReached && <p className="limit-message"><AlertTriangle size={14} /> This region would exceed the configured safety limit.</p>}
            {paper && !online && <p className="limit-message"><Info size={14} /> Start the server to change loaded regions.</p>}
          </div>

          <div className="region-list" aria-label="Force-loaded regions">
            <div className="region-list-heading"><span>Active regions</span><strong>{forceLoads.regions.length} / {forceLoads.maxRegions}</strong></div>
            {forceLoads.regions.map((region) => (
              <article className="region-row" key={region.id}>
                <span className="region-icon"><Map size={16} /></span>
                <div><strong>{dimensionLabels[region.dimension]}</strong><span>X {region.centerX.toLocaleString()} · Z {region.centerZ.toLocaleString()} · radius {region.radius}</span></div>
                <span className="chunk-pill">{region.chunkCount} chunks</span>
                <button className="icon-button" aria-label={`Remove ${dimensionLabels[region.dimension]} region at ${region.centerX}, ${region.centerZ}`} disabled={!paper || busy || !online} onClick={() => onRemoveForceLoad(region.id)}><X size={15} /></button>
              </article>
            ))}
            {!forceLoads.regions.length && <div className="region-empty"><Map size={24} /><strong>No regions are pinned</strong><span>Your server only ticks chunks near players.</span></div>}
          </div>
        </div>
      </section>
    </div>
  )
}

function CatalogPluginCard({ plugin, minecraftVersion, active, busy, installing, onInstall, onOpenSource }: {
  plugin: CatalogPaperPlugin
  minecraftVersion: string
  active: boolean
  busy: boolean
  installing: boolean
  onInstall: () => void
  onOpenSource: () => void
}): React.JSX.Element {
  const installable = plugin.compatible && Boolean(plugin.latestVersion)
  const needsDependency = !plugin.compatible && Boolean(plugin.latestVersion) && Boolean(plugin.requirements.length)
  const buttonLabel = plugin.installed
    ? 'Installed'
    : needsDependency
      ? 'Dependency needed'
    : !installable
      ? 'Not compatible'
      : active
        ? 'Stop Paper'
        : 'Install'
  return (
    <article className={`catalog-card ${plugin.installed ? 'installed' : ''} ${!installable ? 'incompatible' : ''}`}>
      <div className="catalog-card-heading">
        <span className="catalog-avatar" aria-hidden="true">{plugin.name.slice(0, 2).toLocaleUpperCase()}</span>
        <div><span>{categoryLabel(plugin.category)}</span><h3>{plugin.name}</h3><small>by {plugin.author}</small></div>
        {plugin.installed
          ? <span className="catalog-state installed"><Check size={11} /> Installed</span>
          : <span className={`catalog-state ${installable ? 'compatible' : 'incompatible'}`}>{installable ? <ShieldCheck size={11} /> : needsDependency ? <Info size={11} /> : <OctagonX size={11} />}{installable ? 'Compatible' : needsDependency ? 'Needs dependency' : 'Unavailable'}</span>}
      </div>
      <p>{plugin.description}</p>
      {plugin.requirements.length ? <div className="catalog-requirements">{plugin.requirements.map((requirement) => <span key={requirement}>Requires {requirement}</span>)}</div> : null}
      {!installable && plugin.unavailableReason && <p className="catalog-unavailable"><Info size={12} /> {plugin.unavailableReason}</p>}
      <div className="catalog-meta"><span>{formatCount(plugin.downloads)} downloads</span><span>{plugin.license || 'License unknown'}</span><span>{plugin.latestVersion ? `Latest v${plugin.latestVersion}` : `No ${minecraftVersion} release`}</span></div>
      <div className="catalog-card-actions">
        <button type="button" className="catalog-source" onClick={onOpenSource}>View on Modrinth <ExternalLink size={13} /></button>
        <button type="button" className={`button compact ${plugin.installed ? 'secondary' : 'primary'}`} disabled={busy || active || plugin.installed || !installable} title={needsDependency ? plugin.unavailableReason ?? 'Install the required plugin first.' : !installable ? `No compatible release for Minecraft ${minecraftVersion}.` : active ? 'Stop Paper before installing plugins.' : plugin.installed ? 'This plugin is already installed.' : `Install ${plugin.name}`} onClick={onInstall}>{installing ? <LoaderCircle className="spin" size={14} /> : plugin.installed ? <Check size={14} /> : <PackagePlus size={14} />}{installing ? 'Installing' : buttonLabel}</button>
      </div>
    </article>
  )
}

function PluginsView({ instance, plugins, catalog, loading, catalogLoading, busy, installingProjectId, onInstall, onInstallCatalog, onOpenCatalogSource, onRemove, onRefresh, onRefreshCatalog, onCreatePaper }: {
  instance: InstanceView
  plugins: PaperPluginInfo[]
  catalog: CatalogPaperPlugin[]
  loading: boolean
  catalogLoading: boolean
  busy: boolean
  installingProjectId: string | null
  onInstall: () => void
  onInstallCatalog: (projectId: string) => void
  onOpenCatalogSource: (projectId: string) => void
  onRemove: (fileName: string) => void
  onRefresh: () => void
  onRefreshCatalog: () => void
  onCreatePaper: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const paper = instanceSoftware(instance).kind === 'paper'
  const active = instance.runtime.status !== 'offline' && instance.runtime.status !== 'crashed'
  const categories = useMemo(() => [...new Set(catalog.map((plugin) => plugin.category))].sort((left, right) => left.localeCompare(right)), [catalog])
  useEffect(() => {
    if (category !== 'all' && !categories.includes(category)) setCategory('all')
  }, [categories, category])
  const visibleCatalog = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return catalog.filter((plugin) => {
      if (category !== 'all' && plugin.category !== category) return false
      if (!normalizedQuery) return true
      return [plugin.name, plugin.slug, plugin.description, plugin.author, plugin.category]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    })
  }, [catalog, category, query])
  return (
    <div className="page-content plugins-content">
      {!paper && (
        <section className="paper-gate" role="note">
          <div className="paper-gate-icon"><Puzzle size={25} /></div>
          <div><span className="eyebrow">Paper plugin support</span><h2>Plugins need a Paper server.</h2><p>Your Vanilla world stays unchanged. Create a Paper server to install Bukkit, Spigot, and Paper plugin JARs.</p></div>
          <button className="button primary" onClick={onCreatePaper}><Plus size={16} /> New Paper server</button>
        </section>
      )}

      <section className={`plugin-panel catalog-panel ${!paper ? 'paper-disabled' : ''}`} aria-disabled={!paper} aria-labelledby="catalog-title">
        <div className="plugin-heading">
          <div><span className="panel-icon catalog-icon"><Sparkles size={19} /></span><div><span className="eyebrow">Curated catalog</span><h2 id="catalog-title">Recommended Paper plugins</h2><p>Discover trusted project pages with a compatible release for Minecraft {instance.version}.</p></div></div>
          <button className="icon-button" aria-label="Refresh plugin catalog" title="Refresh plugin catalog" disabled={!paper || catalogLoading || busy} onClick={onRefreshCatalog}><RotateCcw className={catalogLoading ? 'spin' : ''} size={17} /></button>
        </div>

        <div className="tool-callout success catalog-trust"><ShieldCheck size={17} /><div><strong>Review the upstream project before installing.</strong><span>Every card shows its author, license, compatibility, and source. EmberHost verifies the selected release before placing it in your server.</span></div></div>
        {paper && active && <div className="tool-callout neutral"><Info size={17} /><div><strong>Stop Paper to install a catalog plugin.</strong><span>Plugin changes are intentionally locked while the Java process is active.</span></div></div>}

        <div className="catalog-toolbar">
          <label className="catalog-search"><Search size={16} /><input aria-label="Search curated plugins" value={query} disabled={!paper} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, author, or feature" /></label>
          <label className="catalog-category"><span>Category</span><select aria-label="Plugin category" value={category} disabled={!paper || !categories.length} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((value) => <option key={value} value={value}>{categoryLabel(value)}</option>)}</select></label>
          <span className="catalog-count">{visibleCatalog.length} of {catalog.length}</span>
        </div>

        <div className="catalog-grid" aria-label="Curated Paper plugin catalog" aria-busy={catalogLoading}>
          {catalogLoading ? <div className="catalog-empty"><LoaderCircle className="spin" size={25} /><strong>Finding compatible plugins...</strong><span>Checking curated projects for Minecraft {instance.version}.</span></div>
            : visibleCatalog.length ? visibleCatalog.map((plugin) => <CatalogPluginCard
                key={plugin.projectId}
                plugin={plugin}
                minecraftVersion={instance.version}
                active={active}
                busy={busy}
                installing={installingProjectId === plugin.projectId}
                onInstall={() => onInstallCatalog(plugin.projectId)}
                onOpenSource={() => onOpenCatalogSource(plugin.projectId)}
              />)
            : <div className="catalog-empty"><Search size={25} /><strong>{catalog.length ? 'No plugins match these filters' : 'The catalog is unavailable'}</strong><span>{catalog.length ? 'Try a broader search or choose All categories.' : 'Refresh the catalog when you are online.'}</span></div>}
        </div>
      </section>

      <section className={`plugin-panel ${!paper ? 'paper-disabled' : ''}`} aria-disabled={!paper}>
        <div className="plugin-heading">
          <div><span className="panel-icon"><Puzzle size={19} /></span><div><span className="eyebrow">Installed and local</span><h2>Paper plugins</h2><p>Manage installed plugins or add a JAR from this computer.</p></div></div>
          <div className="plugin-heading-actions">
            <button className="icon-button" aria-label="Refresh plugin list" title="Refresh plugin list" disabled={!paper || loading || busy} onClick={onRefresh}><RotateCcw className={loading ? 'spin' : ''} size={17} /></button>
            <button className="button primary" disabled={!paper || active || busy} onClick={onInstall}>{busy ? <LoaderCircle className="spin" size={16} /> : <PackagePlus size={16} />} Add plugin JAR</button>
          </div>
        </div>

        <div className="tool-callout amber"><ShieldAlert size={17} /><div><strong>Plugins run with the same access as your server.</strong><span>Only install JARs from developers you trust, and choose a release compatible with Minecraft {instance.version} and Paper.</span></div></div>
        {paper && active && <div className="tool-callout neutral"><Info size={17} /><div><strong>Stop Paper to change plugins.</strong><span>Installed plugins are loaded the next time the server starts.</span></div></div>}

        <div className="plugin-list" aria-label="Installed Paper plugins" aria-busy={loading}>
          <div className="plugin-list-title"><div><strong>Installed</strong><span>{plugins.length} plugin{plugins.length === 1 ? '' : 's'}</span></div><span>Server: Minecraft {instance.version}</span></div>
          {loading ? (
            <div className="plugin-empty"><LoaderCircle className="spin" size={25} /><strong>Reading the plugins folder…</strong></div>
          ) : plugins.length ? plugins.map((plugin) => (
            <article className="plugin-row" key={plugin.fileName}>
              <span className={`plugin-icon ${plugin.builtIn ? 'built-in' : ''}`}><Puzzle size={18} /></span>
              <div className="plugin-copy"><div><strong>{plugin.name ?? plugin.fileName.replace(/\.jar$/i, '')}</strong>{plugin.builtIn && <span className="plugin-badge">EmberHost built-in</span>}{plugin.catalogProjectId && <span className="plugin-badge catalog">Catalog</span>}{!plugin.managed && <span className="plugin-badge neutral">External</span>}</div><span>{plugin.fileName}{plugin.version ? ` · version ${plugin.version}` : ''} · {formatBytes(plugin.sizeBytes)}</span></div>
              <button className="button danger compact" disabled={active || busy || plugin.builtIn} title={plugin.builtIn ? 'Chunky powers World Preparation and cannot be removed.' : 'Move this plugin to Trash'} onClick={() => onRemove(plugin.fileName)}><Trash2 size={15} /> Remove</button>
            </article>
          )) : (
            <div className="plugin-empty"><Puzzle size={27} /><strong>No optional plugins installed</strong><span>Install from the curated catalog or choose Add plugin JAR. Chunky appears here on Paper servers created by EmberHost.</span></div>
          )}
        </div>
      </section>
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

function SettingsView({ instance, totalMemoryMb, appSettings, saving, appSettingsSaving, deleting, onSave, onAppSettings, onDeleteRequest }: {
  instance: InstanceView
  totalMemoryMb: number
  appSettings: AppSettings
  saving: boolean
  appSettingsSaving: boolean
  deleting: boolean
  onSave: (input: UpdateInstanceInput) => Promise<void>
  onAppSettings: (value: AppSettings) => void
  onDeleteRequest: () => void
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
    performancePreset: instance.performancePreset,
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
    performancePreset: instance.performancePreset,
    javaPath: instance.javaPath
  }), [instance.id, instance.updatedAt])

  const update = <K extends keyof UpdateInstanceInput>(key: K, value: UpdateInstanceInput[K]): void => setForm((current) => ({ ...current, [key]: value }))
  const updatePerformanceValue = (key: 'memoryMb' | 'viewDistance' | 'simulationDistance', value: number): void => setForm((current) => {
    const next = { ...current, [key]: value }
    return { ...next, performancePreset: matchingPerformancePreset(next.memoryMb, next.viewDistance, next.simulationDistance) }
  })
  const applyPerformancePreset = (preset: Exclude<PerformancePreset, 'custom'>): void => {
    const values = profileValues(preset, totalMemoryMb)
    setForm((current) => ({ ...current, performancePreset: preset, memoryMb: values.memoryMb, viewDistance: values.viewDistance, simulationDistance: values.simulationDistance }))
  }
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
          <div className="software-summary"><span className={`choice-icon ${instance.software.kind === 'vanilla' ? 'vanilla' : ''}`}>{instance.software.kind === 'paper' ? <Rocket size={18} /> : <Server size={18} />}</span><div><strong>{instance.software.kind === 'paper' ? `Paper build ${instance.software.build}` : 'Vanilla server'}</strong><small>Server software is fixed for this world.</small></div></div>
          <fieldset className="choice-fieldset preset-choices settings-presets"><legend>Performance preset</legend>{presetOptions.map((preset) => <label className={`choice-card preset-card ${form.performancePreset === preset.id ? 'selected' : ''}`} key={preset.id}><input type="radio" name="settings-performance-preset" value={preset.id} checked={form.performancePreset === preset.id} onChange={() => applyPerformancePreset(preset.id)} /><span className="choice-copy"><strong>{preset.label}</strong><small>{preset.description}</small><em>{preset.detail}</em></span><span className="choice-check" aria-hidden="true">{form.performancePreset === preset.id && <Check size={12} />}</span></label>)}</fieldset>
          {form.performancePreset === 'custom' && <div className="custom-profile-note"><Gauge size={13} /> Custom values</div>}
          <div className="field-grid">
            <label className="field"><span>Memory (MB)</span><input type="number" min="1024" max="65536" step="512" value={form.memoryMb} onChange={(event) => updatePerformanceValue('memoryMb', Number(event.target.value))} /></label>
            <label className="field"><span>Server port</span><input type="number" min="1024" max="65535" value={form.port} onChange={(event) => update('port', Number(event.target.value))} /></label>
            <label className="field"><span>View distance</span><input type="number" min="2" max="32" value={form.viewDistance} onChange={(event) => updatePerformanceValue('viewDistance', Number(event.target.value))} /></label>
            <label className="field"><span>Simulation distance</span><input type="number" min="2" max={form.viewDistance} value={form.simulationDistance} onChange={(event) => updatePerformanceValue('simulationDistance', Number(event.target.value))} /></label>
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

      <section className="settings-section danger-zone">
        <div className="settings-title"><span><Trash2 size={19} /></span><div><h3>Delete server</h3><p>Move this server, its world, backups, and plugins to the recycle bin.</p></div></div>
        <div className="settings-fields danger-action"><div><strong>Delete {instance.name}</strong><span>Shared download caches are kept so other servers continue to work.</span></div><button type="button" className="button danger" disabled={active || saving || deleting} onClick={onDeleteRequest}><Trash2 size={16} /> Delete server</button></div>
      </section>

      <div className="save-bar"><span>{active ? 'Configuration is locked while the server is active.' : 'Unknown server.properties entries will be preserved.'}</span><button className="button primary" disabled={saving || active}>{saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} Save changes</button></div>
    </form>
  )
}

function DeleteServerDialog({ instance, deleting, onCancel, onConfirm }: {
  instance: InstanceView
  deleting: boolean
  onCancel: () => void
  onConfirm: (confirmationName: string) => void
}): React.JSX.Element {
  const [confirmationName, setConfirmationName] = useState('')
  const matches = confirmationName === instance.name
  return (
    <div className="dialog-backdrop danger-backdrop">
      <form className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-server-title" onSubmit={(event) => { event.preventDefault(); if (matches && !deleting) onConfirm(confirmationName) }}>
        <span className="confirm-icon"><Trash2 size={23} /></span>
        <span className="eyebrow">Recoverable deletion</span>
        <h2 id="delete-server-title">Delete {instance.name}?</h2>
        <p>EmberHost will move the entire server folder—including worlds, backups, logs, and plugins—to your recycle bin. The server must be stopped.</p>
        <label className="field"><span>Enter <strong>{instance.name}</strong> to confirm</span><input autoFocus value={confirmationName} disabled={deleting} onChange={(event) => setConfirmationName(event.target.value)} /></label>
        <div className="confirm-actions"><button type="button" className="button secondary" disabled={deleting} onClick={onCancel}>Cancel</button><button className="button danger" disabled={!matches || deleting}>{deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} Move to recycle bin</button></div>
      </form>
    </div>
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
  const [worldPreparations, setWorldPreparations] = useState<Record<string, WorldPreparationState>>({})
  const [forceLoadedRegions, setForceLoadedRegions] = useState<Record<string, ForceLoadedRegionsState>>({})
  const [paperPlugins, setPaperPlugins] = useState<Record<string, PaperPluginInfo[]>>({})
  const [paperPluginCatalogs, setPaperPluginCatalogs] = useState<Record<string, CatalogPaperPlugin[]>>({})
  const [busy, setBusy] = useState(false)
  const [worldBusy, setWorldBusy] = useState(false)
  const [pluginLoadingByInstance, setPluginLoadingByInstance] = useState<Record<string, boolean>>({})
  const [catalogLoadingByInstance, setCatalogLoadingByInstance] = useState<Record<string, boolean>>({})
  const [pluginBusy, setPluginBusy] = useState(false)
  const [catalogInstall, setCatalogInstall] = useState<{ instanceId: string; projectId: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<InstanceView | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [appSettingsSaving, setAppSettingsSaving] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [now, setNow] = useState(Date.now())
  const [appSettings, setAppSettings] = useState<AppSettings>({ launchAtLogin: false, minimizeToTray: true })
  const pluginListRequest = useRef<Record<string, number>>({})
  const pluginCatalogRequest = useRef<Record<string, number>>({})

  const selected = useMemo(() => instances.find((instance) => instance.id === selectedId) ?? instances[0] ?? null, [instances, selectedId])
  const selectedLogs = selected ? logs[selected.id] ?? [] : []
  const selectedPreparation = selected ? worldPreparations[selected.id] ?? emptyWorldPreparation(selected.id) : null
  const selectedForceLoads = selected ? forceLoadedRegions[selected.id] ?? emptyForceLoadedRegions(selected.id) : null
  const selectedPlugins = selected ? paperPlugins[selected.id] ?? [] : []
  const selectedPluginCatalog = selected ? paperPluginCatalogs[selected.id] ?? [] : []
  const pluginLoading = selected ? pluginLoadingByInstance[selected.id] === true : false
  const catalogLoading = selected ? catalogLoadingByInstance[selected.id] === true : false
  const selectedActive = selected?.runtime.status === 'online' || selected?.runtime.status === 'starting'
  const selectedStopping = selected?.runtime.status === 'stopping'

  const toast = (kind: Toast['kind'], message: string): void => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, kind, message }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200)
  }

  const refreshLatestVersion = async (): Promise<void> => {
    try {
      const refreshed = await window.emberHost.getBootstrap()
      setBootstrap((current) => current ? {
        ...current,
        latestVersion: refreshed.latestVersion,
        versionLookupError: refreshed.versionLookupError,
        latestPaperBuild: refreshed.latestPaperBuild,
        paperLookupError: refreshed.paperLookupError
      } : current)
      setCreateError(null)
    } catch (error) {
      const message = friendlyError(error)
      setBootstrap((current) => current ? { ...current, latestVersion: null, versionLookupError: message, latestPaperBuild: null, paperLookupError: message } : current)
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
    const paperApi = window.emberHost as PaperApi
    const removePreparation = paperApi.onWorldPreparationChange((state) => setWorldPreparations((current) => ({ ...current, [state.instanceId]: state })))
    const removeForceLoads = paperApi.onForceLoadedRegionsChange((state) => setForceLoadedRegions((current) => ({ ...current, [state.instanceId]: state })))
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { removeProgress(); removeConsole(); removeState(); removePreparation(); removeForceLoads(); window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!selected) return
    void window.emberHost.getLogs(selected.id).then((entries) => setLogs((current) => ({ ...current, [selected.id]: entries })))
    if (instanceSoftware(selected).kind === 'paper') {
      const paperApi = window.emberHost as PaperApi
      void paperApi.getWorldPreparation(selected.id).then((state) => setWorldPreparations((current) => ({ ...current, [selected.id]: state }))).catch(() => undefined)
      void paperApi.getForceLoadedRegions(selected.id).then((state) => setForceLoadedRegions((current) => ({ ...current, [selected.id]: state }))).catch(() => undefined)
    }
  }, [selected?.id])

  useEffect(() => {
    if (!selected || view !== 'plugins' || instanceSoftware(selected).kind !== 'paper') return
    const targetId = selected.id
    const request = (pluginListRequest.current[targetId] ?? 0) + 1
    pluginListRequest.current[targetId] = request
    setPluginLoadingByInstance((current) => ({ ...current, [targetId]: true }))
    void window.emberHost.getPaperPlugins(targetId).then((plugins) => {
      if (request === pluginListRequest.current[targetId]) setPaperPlugins((current) => ({ ...current, [targetId]: plugins }))
    }).catch((error) => {
      if (request === pluginListRequest.current[targetId]) toast('error', friendlyError(error))
    }).finally(() => {
      if (request === pluginListRequest.current[targetId]) setPluginLoadingByInstance((current) => ({ ...current, [targetId]: false }))
    })
    return () => {
      if (request === pluginListRequest.current[targetId]) {
        pluginListRequest.current[targetId] = request + 1
        setPluginLoadingByInstance((current) => ({ ...current, [targetId]: false }))
      }
    }
  }, [selected?.id, view])

  useEffect(() => {
    if (!selected || view !== 'plugins' || instanceSoftware(selected).kind !== 'paper') return
    const targetId = selected.id
    const request = (pluginCatalogRequest.current[targetId] ?? 0) + 1
    pluginCatalogRequest.current[targetId] = request
    setCatalogLoadingByInstance((current) => ({ ...current, [targetId]: true }))
    void window.emberHost.getPaperPluginCatalog(targetId).then((catalog) => {
      if (request === pluginCatalogRequest.current[targetId]) setPaperPluginCatalogs((current) => ({ ...current, [targetId]: catalog }))
    }).catch((error) => {
      if (request === pluginCatalogRequest.current[targetId]) toast('error', friendlyError(error))
    }).finally(() => {
      if (request === pluginCatalogRequest.current[targetId]) setCatalogLoadingByInstance((current) => ({ ...current, [targetId]: false }))
    })
    return () => {
      if (request === pluginCatalogRequest.current[targetId]) {
        pluginCatalogRequest.current[targetId] = request + 1
        setCatalogLoadingByInstance((current) => ({ ...current, [targetId]: false }))
      }
    }
  }, [selected?.id, view])

  const createInstance = async (input: PaperCreateInput): Promise<void> => {
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

  const runPreparationAction = async (
    action: ((api: PaperApi, instanceId: string) => Promise<WorldPreparationState>),
    successMessage: string
  ): Promise<void> => {
    if (!selected || worldBusy) return
    setWorldBusy(true)
    try {
      const result = await action(window.emberHost as PaperApi, selected.id)
      setWorldPreparations((current) => ({ ...current, [result.instanceId]: result }))
      toast('success', successMessage)
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setWorldBusy(false)
    }
  }

  const startWorldPreparation = (input: { radius: number; dimensions: WorldDimension[] }): void => {
    void runPreparationAction((api, instanceId) => api.startWorldPreparation({ instanceId, ...input }), 'World preparation started.')
  }

  const pauseWorldPreparation = (): void => {
    void runPreparationAction((api, instanceId) => api.pauseWorldPreparation(instanceId), 'World preparation paused safely.')
  }

  const resumeWorldPreparation = (): void => {
    void runPreparationAction((api, instanceId) => api.resumeWorldPreparation(instanceId), 'World preparation resumed.')
  }

  const cancelWorldPreparation = (): void => {
    void runPreparationAction((api, instanceId) => api.cancelWorldPreparation(instanceId), 'World preparation cancelled safely.')
  }

  const runForceLoadAction = async (
    action: ((api: PaperApi, instanceId: string) => Promise<ForceLoadedRegionsState>),
    successMessage: string
  ): Promise<void> => {
    if (!selected || worldBusy) return
    setWorldBusy(true)
    try {
      const result = await action(window.emberHost as PaperApi, selected.id)
      setForceLoadedRegions((current) => ({ ...current, [result.instanceId]: result }))
      toast('success', successMessage)
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setWorldBusy(false)
    }
  }

  const addForceLoadedRegion = (input: { dimension: WorldDimension; centerX: number; centerZ: number; radius: number }): void => {
    void runForceLoadAction((api, instanceId) => api.addForceLoadedRegion({ instanceId, ...input }), 'Force-loaded region added.')
  }

  const removeForceLoadedRegion = (regionId: string): void => {
    void runForceLoadAction((api, instanceId) => api.removeForceLoadedRegion({ instanceId, regionId }), 'Force-loaded region removed.')
  }

  const refreshPaperPlugins = async (): Promise<void> => {
    if (!selected || instanceSoftware(selected).kind !== 'paper') return
    const target = selected
    const request = (pluginListRequest.current[target.id] ?? 0) + 1
    pluginListRequest.current[target.id] = request
    setPluginLoadingByInstance((current) => ({ ...current, [target.id]: true }))
    try {
      const plugins = await window.emberHost.getPaperPlugins(target.id)
      if (request === pluginListRequest.current[target.id]) setPaperPlugins((current) => ({ ...current, [target.id]: plugins }))
    } catch (error) {
      if (request === pluginListRequest.current[target.id]) toast('error', friendlyError(error))
    } finally {
      if (request === pluginListRequest.current[target.id]) setPluginLoadingByInstance((current) => ({ ...current, [target.id]: false }))
    }
  }

  const refreshPaperPluginCatalog = async (): Promise<void> => {
    if (!selected || instanceSoftware(selected).kind !== 'paper') return
    const target = selected
    const request = (pluginCatalogRequest.current[target.id] ?? 0) + 1
    pluginCatalogRequest.current[target.id] = request
    setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: true }))
    try {
      const catalog = await window.emberHost.getPaperPluginCatalog(target.id)
      if (request === pluginCatalogRequest.current[target.id]) setPaperPluginCatalogs((current) => ({ ...current, [target.id]: catalog }))
    } catch (error) {
      if (request === pluginCatalogRequest.current[target.id]) toast('error', friendlyError(error))
    } finally {
      if (request === pluginCatalogRequest.current[target.id]) setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: false }))
    }
  }

  const openPaperPluginSource = (projectId: string): void => {
    void window.emberHost.openPaperPluginPage(projectId).catch((error) => toast('error', friendlyError(error)))
  }

  const installCatalogPaperPlugin = async (projectId: string): Promise<void> => {
    if (!selected || pluginBusy || pluginLoading || catalogLoading || instanceSoftware(selected).kind !== 'paper') return
    const target = selected
    const catalogPlugin = selectedPluginCatalog.find((plugin) => plugin.projectId === projectId)
    if (!catalogPlugin || !catalogPlugin.compatible || !catalogPlugin.latestVersion) return
    setPluginBusy(true)
    setCatalogInstall({ instanceId: target.id, projectId })
    try {
      const api = window.emberHost
      const input: CatalogPluginInstallInput = { instanceId: target.id, projectId }
      const plugins = await api.installCatalogPaperPlugin(input)
      pluginListRequest.current[target.id] = (pluginListRequest.current[target.id] ?? 0) + 1
      setPluginLoadingByInstance((current) => ({ ...current, [target.id]: false }))
      setPaperPlugins((current) => ({ ...current, [target.id]: plugins }))
      toast('success', `${catalogPlugin.name} was installed. Start Paper to load it.`)
      const request = (pluginCatalogRequest.current[target.id] ?? 0) + 1
      pluginCatalogRequest.current[target.id] = request
      setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: true }))
      void api.getPaperPluginCatalog(target.id).then((catalog) => {
        if (request === pluginCatalogRequest.current[target.id]) setPaperPluginCatalogs((current) => ({ ...current, [target.id]: catalog }))
      }).catch((error) => {
        if (request === pluginCatalogRequest.current[target.id]) toast('error', `The plugin was installed, but the catalog could not refresh. ${friendlyError(error)}`)
      }).finally(() => {
        if (request === pluginCatalogRequest.current[target.id]) setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: false }))
      })
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setCatalogInstall(null)
      setPluginBusy(false)
    }
  }

  const installPaperPlugin = async (): Promise<void> => {
    if (!selected || pluginBusy || pluginLoading || catalogLoading) return
    const target = selected
    setPluginBusy(true)
    try {
      const result = await window.emberHost.choosePaperPlugin(target.id)
      pluginListRequest.current[target.id] = (pluginListRequest.current[target.id] ?? 0) + 1
      setPluginLoadingByInstance((current) => ({ ...current, [target.id]: false }))
      setPaperPlugins((current) => ({ ...current, [target.id]: result.plugins }))
      if (!result.canceled) {
        const request = (pluginCatalogRequest.current[target.id] ?? 0) + 1
        pluginCatalogRequest.current[target.id] = request
        setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: true }))
        void window.emberHost.getPaperPluginCatalog(target.id).then((catalog) => {
          if (request === pluginCatalogRequest.current[target.id]) setPaperPluginCatalogs((current) => ({ ...current, [target.id]: catalog }))
        }).catch(() => undefined).finally(() => {
          if (request === pluginCatalogRequest.current[target.id]) setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: false }))
        })
      }
      if (!result.canceled && result.installed) toast('success', `${result.installed.name ?? result.installed.fileName} was added. Start Paper to load it.`)
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setPluginBusy(false)
    }
  }

  const removePaperPlugin = async (fileName: string): Promise<void> => {
    if (!selected || pluginBusy || pluginLoading || catalogLoading) return
    const target = selected
    setPluginBusy(true)
    try {
      const plugins = await window.emberHost.removePaperPlugin({ instanceId: target.id, fileName })
      pluginListRequest.current[target.id] = (pluginListRequest.current[target.id] ?? 0) + 1
      setPluginLoadingByInstance((current) => ({ ...current, [target.id]: false }))
      setPaperPlugins((current) => ({ ...current, [target.id]: plugins }))
      const request = (pluginCatalogRequest.current[target.id] ?? 0) + 1
      pluginCatalogRequest.current[target.id] = request
      setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: true }))
      void window.emberHost.getPaperPluginCatalog(target.id).then((catalog) => {
        if (request === pluginCatalogRequest.current[target.id]) setPaperPluginCatalogs((current) => ({ ...current, [target.id]: catalog }))
      }).catch(() => undefined).finally(() => {
        if (request === pluginCatalogRequest.current[target.id]) setCatalogLoadingByInstance((current) => ({ ...current, [target.id]: false }))
      })
      toast('success', `${fileName} was moved to the recycle bin.`)
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setPluginBusy(false)
    }
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

  const deleteInstance = async (confirmationName: string): Promise<void> => {
    if (!deleteTarget || deleting) return
    const target = deleteTarget
    setDeleting(true)
    try {
      await window.emberHost.deleteInstance({ id: target.id, confirmationName })
      const remaining = instances.filter((instance) => instance.id !== target.id)
      setInstances(remaining)
      setSelectedId(remaining[0]?.id ?? null)
      setLogs((current) => { const next = { ...current }; delete next[target.id]; return next })
      setWorldPreparations((current) => { const next = { ...current }; delete next[target.id]; return next })
      setForceLoadedRegions((current) => { const next = { ...current }; delete next[target.id]; return next })
      setPaperPlugins((current) => { const next = { ...current }; delete next[target.id]; return next })
      setPaperPluginCatalogs((current) => { const next = { ...current }; delete next[target.id]; return next })
      setDeleteTarget(null)
      setView('overview')
      if (!remaining.length) setShowCreate(true)
      toast('success', `${target.name} was moved to the recycle bin.`)
    } catch (error) {
      toast('error', friendlyError(error))
    } finally {
      setDeleting(false)
    }
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
          <button className={view === 'world' ? 'active' : ''} onClick={() => setView('world')}><Map size={18} /> World tools {selected && instanceSoftware(selected).kind === 'paper' && <span className="nav-new">Paper</span>}</button>
          <button className={view === 'plugins' ? 'active' : ''} onClick={() => setView('plugins')}><Puzzle size={18} /> Plugins {selected && instanceSoftware(selected).kind === 'paper' && <span className="nav-new">Paper</span>}</button>
          <button className={view === 'console' ? 'active' : ''} onClick={() => setView('console')}><SquareTerminal size={18} /> Console {selectedLogs.some((entry) => entry.level === 'error') && <i />}</button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Settings size={18} /> Settings</button>
        </nav>
        <div className="sidebar-spacer" />
        <button className="new-server-side" onClick={openCreate}><Plus size={17} /> New server</button>
        {selected && <div className="sidebar-status"><div><span className={`status-dot status-${selected.runtime.status}`} /><div><strong>{selected.name}</strong><small>{statusLabels[selected.runtime.status]} · {selected.software.kind === 'paper' ? 'Paper' : 'Vanilla'} · :{selected.port}</small></div></div>{selected.software.kind === 'paper' ? <Rocket size={18} /> : <Server size={18} />}</div>}
        <div className="app-version">EmberHost v{bootstrap.appVersion}</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div><span className="eyebrow">{view === 'overview' ? 'Server workspace' : view === 'world' ? 'Paper operations' : view === 'plugins' ? 'Paper extensions' : view === 'console' ? 'Live operations' : 'Configuration'}</span><h1>{view === 'overview' ? selected?.name ?? 'Your server' : view === 'world' ? 'World tools' : view === 'plugins' ? 'Plugins' : view === 'console' ? 'Console' : 'Settings'}</h1></div>
          <div className="topbar-actions">
            {selected && <StatusBadge status={selected.runtime.status} />}
            {selected && <button className="icon-button" title="Open server folder" aria-label="Open server folder" onClick={() => void window.emberHost.openServerFolder(selected.id).catch((error) => toast('error', friendlyError(error)))}><FolderOpen size={18} /></button>}
            <button className="button secondary compact" onClick={openCreate}><Plus size={16} /> New server</button>
            {selected && <button className={`button compact ${selectedActive || selectedStopping ? 'danger' : 'primary'}`} disabled={busy || selectedStopping} onClick={() => void startStop()}>{busy || selectedStopping ? <LoaderCircle className="spin" size={16} /> : selectedActive ? <CircleStop size={16} /> : <Play size={16} />}{selectedStopping ? 'Stopping' : selectedActive ? 'Stop' : 'Start'}</button>}
          </div>
        </header>

        {selected ? (
          view === 'overview' ? <Overview instance={selected} address={`${bootstrap.lanAddresses[0] ?? 'localhost'}:${selected.port}`} logs={selectedLogs} now={now} busy={busy} onStartStop={() => void startStop()} onOpenFolder={() => void window.emberHost.openServerFolder(selected.id).catch((error) => toast('error', friendlyError(error)))} onCopy={() => { void navigator.clipboard.writeText(`${bootstrap.lanAddresses[0] ?? 'localhost'}:${selected.port}`).then(() => toast('info', 'Server address copied.')).catch((error) => toast('error', friendlyError(error))) }} onConsole={() => setView('console')} onWorld={() => setView('world')} />
             : view === 'world' && selectedPreparation && selectedForceLoads ? <WorldToolsView key={selected.id} instance={selected} preparation={selectedPreparation} forceLoads={selectedForceLoads} busy={worldBusy} onStartPreparation={startWorldPreparation} onPausePreparation={pauseWorldPreparation} onResumePreparation={resumeWorldPreparation} onCancelPreparation={cancelWorldPreparation} onAddForceLoad={addForceLoadedRegion} onRemoveForceLoad={removeForceLoadedRegion} onCreatePaper={openCreate} />
               : view === 'plugins' ? <PluginsView key={selected.id} instance={selected} plugins={selectedPlugins} catalog={selectedPluginCatalog} loading={pluginLoading} catalogLoading={catalogLoading} busy={pluginBusy || pluginLoading || catalogLoading} installingProjectId={catalogInstall?.instanceId === selected.id ? catalogInstall.projectId : null} onInstall={() => void installPaperPlugin()} onInstallCatalog={(projectId) => void installCatalogPaperPlugin(projectId)} onOpenCatalogSource={openPaperPluginSource} onRemove={(fileName) => void removePaperPlugin(fileName)} onRefresh={() => void refreshPaperPlugins()} onRefreshCatalog={() => void refreshPaperPluginCatalog()} onCreatePaper={openCreate} />
               : view === 'console' ? <ConsoleView key={selected.id} instance={selected} logs={selectedLogs} onSend={sendCommand} />
                : <SettingsView instance={selected} totalMemoryMb={bootstrap.totalMemoryMb} appSettings={appSettings} saving={saving} appSettingsSaving={appSettingsSaving} deleting={deleting} onSave={saveSettings} onAppSettings={saveAppSettings} onDeleteRequest={() => setDeleteTarget(selected)} />
        ) : <div className="empty-workspace"><div className="brand-mark large"><span>E</span></div><h2>Create your first server</h2><p>Start with recommended Paper performance or choose the official Vanilla experience.</p><button className="button primary" onClick={openCreate}><Plus size={17} /> Create a server</button></div>}
      </main>

      {showCreate && <CreateServerDialog bootstrap={bootstrap} canClose={instances.length > 0} progress={createProgress} creating={creating} error={createError} onClose={() => setShowCreate(false)} onCreate={createInstance} />}
      {deleteTarget && <DeleteServerDialog instance={deleteTarget} deleting={deleting} onCancel={() => setDeleteTarget(null)} onConfirm={(confirmationName) => void deleteInstance(confirmationName)} />}
      <div className="toast-region" aria-live="polite">{toasts.map((item) => <div key={item.id} className={`toast toast-${item.kind}`}>{item.kind === 'error' ? <AlertTriangle size={17} /> : item.kind === 'success' ? <Check size={17} /> : <Clipboard size={17} />}<span>{item.message}</span></div>)}</div>
    </div>
  )
}
