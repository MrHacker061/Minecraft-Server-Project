import { isIPv4 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

export type NetworkInterfaceSnapshot = ReturnType<typeof networkInterfaces>
export type NetworkInterfaceSource = () => NetworkInterfaceSnapshot

interface AddressCandidate {
  address: string
  interfaceName: string
  order: number
  score: number
  numericAddress: number
}

const virtualInterfacePattern = /(?:virtual|vethernet|hyper-v|wsl|docker|podman|vmware|virtualbox|vbox|tailscale|zerotier|hamachi|radmin|vpn|tunnel|(?:^|[\s_-])tun\d*|(?:^|[\s_-])tap\d*|utun|bridge|(?:^|[\s_-])br-)/i
const physicalInterfacePattern = /(?:^|[\s_-])(?:wi-?fi|wifi|wireless|wlan\d*|ethernet)(?:[\s_-]|$)|^(?:en\d+|enp\w+|eno\w+|ens\w+|eth\d+|wlp\w+)$/i

function ipv4Octets(address: string): [number, number, number, number] | null {
  if (!isIPv4(address)) return null
  const values = address.split('.').map(Number)
  if (values.length !== 4 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null
  return values as [number, number, number, number]
}

function isUsableAddress(octets: [number, number, number, number]): boolean {
  const [first, second] = octets
  return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254)
}

function isPrivateAddress([first, second]: [number, number, number, number]): boolean {
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function numericAddress(octets: [number, number, number, number]): number {
  return octets.reduce((value, octet) => value * 256 + octet, 0)
}

function candidateScore(interfaceName: string, address: NetworkInterfaceInfo, octets: [number, number, number, number]): number {
  let score = isPrivateAddress(octets) ? 100 : 0
  if (virtualInterfacePattern.test(interfaceName)) score -= 1_000
  else if (physicalInterfacePattern.test(interfaceName)) score += 1_000
  if (address.cidr?.endsWith('/32')) score -= 20
  return score
}

export function selectLanAddresses(snapshot: NetworkInterfaceSnapshot): string[] {
  const candidates = new Map<string, AddressCandidate>()
  let order = 0

  for (const [interfaceName, addresses] of Object.entries(snapshot)) {
    for (const candidate of addresses ?? []) {
      const currentOrder = order++
      if ((candidate.family as string | number) !== 'IPv4' && (candidate.family as string | number) !== 4) continue
      if (candidate.internal) continue
      const octets = ipv4Octets(candidate.address)
      if (!octets || !isUsableAddress(octets)) continue

      const value: AddressCandidate = {
        address: candidate.address,
        interfaceName,
        order: currentOrder,
        score: candidateScore(interfaceName, candidate, octets),
        numericAddress: numericAddress(octets)
      }
      const existing = candidates.get(candidate.address)
      if (!existing || value.score > existing.score || (
        value.score === existing.score && value.interfaceName.localeCompare(existing.interfaceName) < 0
      )) candidates.set(candidate.address, value)
    }
  }

  return [...candidates.values()]
    .sort((left, right) =>
      right.score - left.score ||
      left.interfaceName.localeCompare(right.interfaceName) ||
      left.numericAddress - right.numericAddress ||
      left.order - right.order)
    .map((candidate) => candidate.address)
}

export function getLanAddresses(source: NetworkInterfaceSource = networkInterfaces): string[] {
  return selectLanAddresses(source())
}
