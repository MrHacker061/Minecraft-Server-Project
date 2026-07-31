import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  getLanAddresses,
  selectLanAddresses,
  type NetworkInterfaceSnapshot
} from '../src/main/services/network'

function ipv4(address: string, options: { internal?: boolean; cidr?: string } = {}): NetworkInterfaceInfo {
  return {
    address,
    netmask: options.cidr?.endsWith('/32') ? '255.255.255.255' : '255.255.255.0',
    family: 'IPv4',
    mac: '00:11:22:33:44:55',
    internal: options.internal ?? false,
    cidr: options.cidr ?? `${address}/24`
  }
}

function ipv6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:11:22:33:44:55',
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0
  }
}

describe('LAN address discovery', () => {
  it('prefers a physical Wi-Fi address over an earlier virtual adapter', () => {
    const snapshot: NetworkInterfaceSnapshot = {
      'vEthernet (Default Switch)': [ipv4('10.128.134.244', { cidr: '10.128.134.244/32' })],
      'Wi-Fi': [ipv4('192.168.1.110')]
    }

    expect(selectLanAddresses(snapshot)).toEqual(['192.168.1.110', '10.128.134.244'])
  })

  it('filters loopback, IPv6, APIPA, unspecified, and multicast addresses', () => {
    const snapshot: NetworkInterfaceSnapshot = {
      Ethernet: [
        ipv4('127.0.0.1'),
        ipv4('192.168.1.22', { internal: true }),
        ipv4('169.254.25.171'),
        ipv4('0.0.0.0'),
        ipv4('224.0.0.1'),
        ipv6('fe80::1')
      ]
    }

    expect(selectLanAddresses(snapshot)).toEqual([])
  })

  it('retains legitimate physical 10/8 LANs and keeps virtual addresses as alternatives', () => {
    const snapshot: NetworkInterfaceSnapshot = {
      'Docker Desktop': [ipv4('192.168.65.1')],
      Ethernet: [ipv4('10.0.0.42')],
      'Unknown adapter': [ipv4('203.0.113.8')]
    }

    expect(selectLanAddresses(snapshot)).toEqual(['10.0.0.42', '203.0.113.8', '192.168.65.1'])
  })

  it('deduplicates deterministically without mutating the interface snapshot', () => {
    const snapshot: NetworkInterfaceSnapshot = {
      'Unknown adapter': [ipv4('192.168.1.110'), ipv4('192.168.1.120')],
      'Wi-Fi': [ipv4('192.168.1.110')]
    }
    const before = JSON.stringify(snapshot)

    expect(selectLanAddresses(snapshot)).toEqual(['192.168.1.110', '192.168.1.120'])
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('reads every snapshot instead of caching an address from a prior network', () => {
    const source = vi.fn()
      .mockReturnValueOnce({ VPN: [ipv4('10.128.134.244', { cidr: '10.128.134.244/32' })] })
      .mockReturnValueOnce({ 'Wi-Fi': [ipv4('192.168.1.110')] })

    expect(getLanAddresses(source)).toEqual(['10.128.134.244'])
    expect(getLanAddresses(source)).toEqual(['192.168.1.110'])
    expect(source).toHaveBeenCalledTimes(2)
  })
})
