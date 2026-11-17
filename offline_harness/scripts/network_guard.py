#!/usr/bin/env python3
"""Plan, explicitly install, or read-only verify a scoped Linux Docker LAN egress guard.

No command defaults to applying changes. This is not a Docker target deployer.
"""
import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

DISPATCH = 'QCTF_DISPATCH'
HOST_INPUT = 'QCTF_INPUT'
PRIVATE = tuple(ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
POLICY_KEYS = {'version', 'containerId', 'networkId', 'bridge', 'sourceIp', 'solverSubnet', 'allowedCidrs', 'hostIps'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def ipv4(value):
    require(isinstance(value, str), 'An IPv4 string is required')
    ip = ipaddress.ip_address(value)
    require(isinstance(ip, ipaddress.IPv4Address) and str(ip) == value, 'Canonical IPv4 required')
    return ip


def network(value):
    require(isinstance(value, str), 'A CIDR string is required')
    net = ipaddress.ip_network(value, strict=True)
    require(isinstance(net, ipaddress.IPv4Network) and str(net) == value, 'Canonical IPv4 CIDR required')
    require(any(net.subnet_of(private) for private in PRIVATE), 'Only explicit RFC1918 targets are supported')
    return net


def validate_policy(policy):
    require(isinstance(policy, dict) and set(policy) == POLICY_KEYS and policy.get('version') == 1, 'Unknown LAN policy fields/version')
    for key in ('containerId', 'networkId'):
        require(isinstance(policy[key], str) and re.fullmatch('[0-9a-f]{64}', policy[key]), 'Full Docker identity required')
    require(isinstance(policy['bridge'], str) and re.fullmatch(r'ctf-[a-z0-9-]{1,11}', policy['bridge']), 'Dedicated bridge name must be ctf-* and at most 15 characters')
    source = ipv4(policy['sourceIp'])
    subnet = network(policy['solverSubnet'])
    require(source in subnet and source not in (subnet.network_address, subnet.broadcast_address), 'Solver IP must be a usable address in its subnet')
    targets = policy['allowedCidrs']
    require(isinstance(targets, list) and 1 <= len(targets) <= 64 and len(set(targets)) == len(targets), 'Declare 1..64 unique target CIDRs')
    for value in targets:
        require(not network(value).overlaps(subnet), 'Targets must not overlap the solver bridge subnet')
    host_ips = policy['hostIps']
    require(isinstance(host_ips, list) and 1 <= len(host_ips) <= 128 and len(set(host_ips)) == len(host_ips), 'Declare the current host IPv4 addresses')
    for value in host_ips:
        ipv4(value)
    require(policy['sourceIp'] not in host_ips, 'Solver IP cannot be a host address')
    return policy


def chain_name(policy):
    canonical = json.dumps(validate_policy(policy), sort_keys=True, separators=(',', ':')).encode()
    return 'QCTF_' + hashlib.sha256(canonical).hexdigest()[:12].upper()


def expected_rules(policy):
    validate_policy(policy)
    chain = chain_name(policy)
    rules = []
    # Both current and pre-DNAT destination are checked. Host-bound INPUT is also dropped.
    for value in sorted(policy['hostIps']):
        rules.append(['-d', value + '/32', '-j', 'DROP'])
        rules.append(['-m', 'conntrack', '--ctorigdst', value + '/32', '-j', 'DROP'])
    for protocol in ('tcp', 'udp'):
        rules.append(['-p', protocol, '-m', 'multiport', '--dports', '53,853,2375,2376', '-j', 'DROP'])
    for target in sorted(policy['allowedCidrs']):
        for protocol in ('tcp', 'udp', 'icmp'):
            rules.append(['-p', protocol, '-d', target, '-m', 'conntrack', '--ctorigdst', target,
                          '--ctdir', 'ORIGINAL', '--ctstate', 'NEW,ESTABLISHED', '-j', 'RETURN'])
    rules.append(['-j', 'DROP'])
    scope = ['-i', policy['bridge'], '-s', policy['sourceIp'] + '/32']
    return {'chain': chain, 'rules': rules, 'dispatch': scope + ['-j', chain], 'input': scope + ['-j', 'DROP']}


def normalize_rule(rule):
    result = list(rule)
    for index, word in enumerate(result[:-1]):
        if word in ('-s', '-d', '--ctorigdst'):
            result[index + 1] = str(ipaddress.ip_network(result[index + 1], strict=False))
        elif word == '--ctstate':
            result[index + 1] = ','.join(sorted(result[index + 1].split(',')))
    # iptables-save moves core flags ahead of match extensions and can reorder
    # conntrack flags. Compare option/value pairs, retaining duplicate options.
    # Negation/unknown syntax stays literal and cannot match our generated rules.
    known = ['-i', '-s', '-p', '-d', '-m', '--dports', '--ctorigdst', '--ctdir', '--ctstate', '-j']
    if len(result) % 2 == 0 and all(result[i] in known for i in range(0, len(result), 2)):
        pairs = [result[i:i+2] for i in range(0, len(result), 2)]
        return [word for pair in sorted(pairs, key=lambda p: known.index(p[0])) for word in pair]
    return result


def parse_saved_rules(text):
    rules, policies, active, complete = {}, {}, False, False
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        if line == '*filter':
            require(not active and not complete, 'Expected exactly one filter table')
            active = True
        elif line == 'COMMIT':
            require(active, 'Unexpected COMMIT')
            active = False; complete = True
        elif line.startswith(':') and active:
            name, policy, _ = line[1:].split()
            require(name not in rules, 'Duplicate chain declaration')
            rules[name] = []; policies[name] = policy
        elif line.startswith('-A ') and active:
            parts = shlex.split(line)
            require(parts[1] in rules, 'Undeclared firewall chain')
            rules[parts[1]].append(normalize_rule(parts[2:]))
        else:
            raise ValueError('Unsupported iptables-save syntax/table')
    require(complete and not active, 'Incomplete firewall snapshot')
    return rules, policies


def validate_dispatch(rules, chain, destination_pattern):
    seen = set()
    for rule in rules.get(chain, []):
        require(len(rule) == 6 and rule[0] == '-i' and rule[2] == '-s' and rule[4] == '-j', 'Unexpected shared dispatcher rule')
        require(re.fullmatch(r'ctf-[a-z0-9-]{1,11}', rule[1]), 'Unscoped bridge dispatcher rule')
        net = ipaddress.ip_network(rule[3])
        require(net.version == 4 and net.prefixlen == 32, 'Dispatcher must scope a single solver IP')
        require(re.fullmatch(destination_pattern, rule[5]), 'Unexpected shared dispatcher target')
        key = (rule[1], rule[3])
        require(key not in seen, 'Duplicate solver scope in dispatcher')
        seen.add(key)


def verify_saved_rules(policy, text):
    expected = expected_rules(policy)
    rules, policies = parse_saved_rules(text)
    required = ('INPUT', 'FORWARD', 'DOCKER-USER', DISPATCH, HOST_INPUT, expected['chain'])
    require(all(name in rules for name in required), 'Missing Docker/guard chains; native nftables/rootless/Desktop is not supported')
    for name in required[2:]:
        require(policies[name] == '-', 'Guard must use user-defined chains')
    require(rules['FORWARD'] and rules['FORWARD'][0] == ['-j', 'DOCKER-USER'], 'DOCKER-USER must precede forwarding bypass rules')
    require(rules['DOCKER-USER'] and rules['DOCKER-USER'][0] == ['-j', DISPATCH], 'Egress guard must be first in DOCKER-USER')
    require(rules['DOCKER-USER'].count(['-j', DISPATCH]) == 1, 'Duplicate egress hook')
    require(rules['INPUT'] and rules['INPUT'][0] == ['-j', HOST_INPUT], 'Host guard must precede INPUT accept rules')
    require(rules['INPUT'].count(['-j', HOST_INPUT]) == 1, 'Duplicate host hook')
    validate_dispatch(rules, DISPATCH, r'QCTF_[0-9A-F]{12}')
    validate_dispatch(rules, HOST_INPUT, 'DROP')
    require(normalize_rule(expected['dispatch']) in rules[DISPATCH], 'Solver egress dispatch missing or changed')
    require(normalize_rule(expected['input']) in rules[HOST_INPUT], 'Solver host-input guard missing or changed')
    require(rules[expected['chain']] == [normalize_rule(r) for r in expected['rules']], 'Dedicated egress rules differ from the frozen policy')
    return {'chain': expected['chain'], 'rulesSha256': hashlib.sha256(text.encode()).hexdigest()}


def plan_install(policy, text):
    expected = expected_rules(policy)
    rules, policies = parse_saved_rules(text)
    require('DOCKER-USER' in rules and 'FORWARD' in rules and 'INPUT' in rules, 'Linux Docker iptables chains are required')
    require(rules['FORWARD'] and rules['FORWARD'][0] == ['-j', 'DOCKER-USER'], 'Unsupported forwarding chain ordering')
    if expected['chain'] in rules:
        verify_saved_rules(policy, text)
        return []  # Identical installed policy is idempotent.
    commands = []
    for name, target, pattern in ((DISPATCH, 'DOCKER-USER', r'QCTF_[0-9A-F]{12}'), (HOST_INPUT, 'INPUT', 'DROP')):
        if name in rules:
            require(policies[name] == '-', 'Owned dispatcher name collision')
            validate_dispatch(rules, name, pattern)
            require(rules[target] and rules[target][0] == ['-j', name] and rules[target].count(['-j', name]) == 1, 'Existing dispatcher is not the unique first hook')
        else:
            require(not any(name in rule for chain in rules.values() for rule in chain), 'Unrecognized dispatcher reference')
            commands.append(['-N', name])
        scope = normalize_rule(expected['dispatch'] if name == DISPATCH else expected['input'])[:4]
        require(not any(rule[:4] == scope for rule in rules.get(name, [])), 'This solver already has another policy; review it rather than overwrite')
    commands.append(['-N', expected['chain']])
    commands += [['-A', expected['chain'], *rule] for rule in expected['rules']]
    commands.append(['-A', HOST_INPUT, *expected['input']])
    commands.append(['-A', DISPATCH, *expected['dispatch']])
    # Hooks come last. Installation requires the declared new solver to be stopped.
    if HOST_INPUT not in rules:
        commands.append(['-I', 'INPUT', '1', '-j', HOST_INPUT])
    if DISPATCH not in rules:
        commands.append(['-I', 'DOCKER-USER', '1', '-j', DISPATCH])
    return commands


def actual_host_ips(addresses):
    return sorted({item['local'] for interface in addresses for item in interface.get('addr_info', []) if item.get('family') == 'inet'})


def validate_topology(policy, container, net, addresses, link, bridge_filter):
    validate_policy(policy)
    require(container.get('Id') == policy['containerId'] and net.get('Id') == policy['networkId'], 'Docker identity differs from policy')
    require(net.get('Driver') == 'bridge' and not net.get('Internal') and not net.get('EnableIPv6'), 'LAN guard requires one IPv4 Linux bridge')
    require(net.get('Labels', {}).get('qwen.contest.egress') == 'managed', 'Network lacks dedicated managed label')
    require(net.get('Options', {}).get('com.docker.network.bridge.name') == policy['bridge'], 'Bridge interface differs from policy')
    configs = net.get('IPAM', {}).get('Config', [])
    require(len(configs) == 1 and configs[0].get('Subnet') == policy['solverSubnet'], 'Bridge subnet differs from policy')
    networks = container.get('NetworkSettings', {}).get('Networks', {})
    require(len(networks) == 1, 'Solver must have exactly one network')
    endpoint = next(iter(networks.values()))
    require(endpoint.get('NetworkID') in ('', policy['networkId']) and (endpoint.get('IPAddress') or endpoint.get('IPAMConfig', {}).get('IPv4Address')) == policy['sourceIp'], 'Solver endpoint differs from policy')
    require(not endpoint.get('GlobalIPv6Address'), 'IPv6 solver endpoints are unsupported')
    h = container.get('HostConfig', {})
    require(h.get('Dns') == ['127.0.0.1'], 'Use container-loopback DNS only')
    require(all(str(h.get('Sysctls', {}).get(f'net.ipv6.conf.{scope}.disable_ipv6')) == '1' for scope in ('all', 'default')), 'IPv6 must be disabled in the container namespace')
    require(not h.get('Privileged') and not h.get('CapAdd') and any(str(c).upper() == 'ALL' for c in h.get('CapDrop', [])), 'Solver network privileges must be dropped')
    require(not h.get('PortBindings') and h.get('NetworkMode') not in ('host', 'none'), 'Published/host networking is not permitted for LAN solver')
    require(not any(str(e).split('=', 1)[0].lower() in ('http_proxy', 'https_proxy', 'all_proxy') and str(e).partition('=')[2] for e in container.get('Config', {}).get('Env', [])), 'Proxy environment variables are not permitted')
    require(actual_host_ips(addresses) == sorted(policy['hostIps']), 'Host addresses changed; regenerate and review the policy')
    require(len(link) == 1 and link[0].get('ifname') == policy['bridge'] and link[0].get('linkinfo', {}).get('info_kind') == 'bridge', 'Declared Linux bridge does not exist')
    require(str(bridge_filter).strip() == '1', 'bridge-nf-call-iptables must already be enabled')


def load_policy(filename, expected_sha=None):
    path = Path(filename)
    require(path.is_file() and not path.is_symlink(), 'Policy must be a regular non-symlink file')
    raw = path.read_bytes(); require(len(raw) <= 65536, 'Policy too large')
    sha = hashlib.sha256(raw).hexdigest()
    require(expected_sha is None or sha == expected_sha, 'Policy digest changed')
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate policy key'); value[key] = item
        return value
    return validate_policy(json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique)), sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'apply', 'verify'], nargs='?', default='plan')
    parser.add_argument('--policy', required=True)
    parser.add_argument('--expect-sha256')
    parser.add_argument('--apply', action='store_true', help='Required in addition to the apply subcommand')
    parser.add_argument('--docker', default='docker')
    parser.add_argument('--docker-host', default='unix:///var/run/docker.sock')
    parser.add_argument('--iptables', default='iptables')
    parser.add_argument('--iptables-save', default='iptables-save')
    args = parser.parse_args()
    policy, sha = load_policy(args.policy, args.expect_sha256)
    require(args.docker_host.startswith('unix:///'), 'Only a local Linux Docker socket is supported')
    require(args.action != 'apply' or args.apply, 'Applying requires both apply and --apply')
    require(args.action == 'apply' or not args.apply, '--apply is valid only with the apply subcommand')
    if args.action == 'plan':
        expected = expected_rules(policy)
        print(json.dumps({'policySha256': sha, 'scope': policy, 'chain': expected['chain'],
                          'rules': expected['rules'], 'dispatchRule': expected['dispatch'],
                          'inputRule': expected['input'], 'applied': False,
                          'note': 'No Docker, firewall, network, or process state was accessed. Actual installation requires live preflight.'}, indent=2))
        return
    env = {'PATH': os.environ.get('PATH', '/usr/sbin:/usr/bin:/sbin:/bin'), 'DOCKER_HOST': args.docker_host}
    def call(argv):
        return subprocess.run(argv, env=env, text=True, capture_output=True, check=True, timeout=15).stdout
    snapshot = call([args.iptables_save, '-t', 'filter'])
    container = json.loads(call([args.docker, 'inspect', policy['containerId']]))[0]
    net = json.loads(call([args.docker, 'network', 'inspect', policy['networkId']]))[0]
    addresses = json.loads(call(['ip', '-j', '-4', 'address', 'show']))
    link = json.loads(call(['ip', '-j', '-d', 'link', 'show', 'dev', policy['bridge']]))
    filtering = call(['sysctl', '-n', 'net.bridge.bridge-nf-call-iptables'])
    validate_topology(policy, container, net, addresses, link, filtering)
    applied = False
    if args.action == 'apply':
        require(not container.get('State', {}).get('Running'), 'Only a stopped, separately provisioned solver may receive a new guard')
        for rule in plan_install(policy, snapshot):
            call([args.iptables, '-w', '5', *rule])
        snapshot = call([args.iptables_save, '-t', 'filter']); applied = True
    verified = verify_saved_rules(policy, snapshot)
    print(json.dumps({'verified': True, 'applied': applied, 'policySha256': sha,
                      'containerId': policy['containerId'], 'networkId': policy['networkId'],
                      'sourceIp': policy['sourceIp'], 'bridge': policy['bridge'], **verified,
                      'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat()}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, IndexError, TypeError) as error:
        print(json.dumps({'verified': False, 'error': str(error)}), file=sys.stderr)
        raise SystemExit(1)
