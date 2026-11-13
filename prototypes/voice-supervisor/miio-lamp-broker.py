"""Private stdio executor; disabled actuation unless explicitly selected by its owner."""
import argparse
import contextlib
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import time
import uuid

MODEL = 'yeelink.light.lamp27'


class Refused(Exception):
    pass


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


class OwnerLock:
    """OS-owned lock, shared by processes selecting the same actual home."""
    def __init__(self, home_hash):
        self.handle = None
        if os.name == 'nt':
            self.api = ctypes.WinDLL('kernel32', use_last_error=True)
            self.api.CreateMutexW.restype = wintypes.HANDLE
            self.api.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
            self.api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            self.api.ReleaseMutex.argtypes = [wintypes.HANDLE]
            self.api.CloseHandle.argtypes = [wintypes.HANDLE]
            self.handle = self.api.CreateMutexW(None, False, 'Local\\VoiceMiioHome-' + home_hash[:32])
            if not self.handle or self.api.WaitForSingleObject(self.handle, 0) not in (0, 128):
                if self.handle:
                    self.api.CloseHandle(self.handle)
                self.handle = None
                raise Refused('control_owner_busy')
        else:
            import fcntl
            self.fcntl = fcntl
            self.handle = os.open(Path(tempfile.gettempdir()) / ('voice-miio-home-' + home_hash[:32]), os.O_CREAT | os.O_RDWR, 0o600)
            try:
                fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(self.handle)
                self.handle = None
                raise Refused('control_owner_busy') from None

    def close(self):
        if self.handle is None:
            return
        if os.name == 'nt':
            self.api.ReleaseMutex(self.handle)
            self.api.CloseHandle(self.handle)
        else:
            self.fcntl.flock(self.handle, self.fcntl.LOCK_UN)
            os.close(self.handle)
        self.handle = None


class Deadline:
    def __init__(self, budget_ms):
        self.until = time.perf_counter() + budget_ms / 1000

    def remaining(self):
        value = self.until - time.perf_counter()
        if value <= 0:
            raise Refused('operation_deadline')
        return value


def inventory(path, expected_hash):
    payload = json.loads(path.read_text(encoding='utf-8-sig'))
    homes = [h for block in payload for h in block.get('homes', []) if str(h.get('home_id', '')).endswith('3625')]
    if len(homes) != 1:
        raise Refused('home_not_unique')
    devices = [d for d in homes[0].get('devices', []) if d.get('model') == MODEL]
    if len(devices) != 1:
        raise Refused('lamp_not_unique')
    device = devices[0]
    identity = device.get('did') or device.get('device_id') or device.get('id')
    if identity is None or not device.get('localip') or not device.get('token'):
        raise Refused('lamp_identity_incomplete')
    if digest(identity)[:16] != expected_hash:
        raise Refused('lamp_identity_changed')
    return digest(homes[0]['home_id']), device, str(identity)


class RealLamp:
    """Installed SDK crypto/protocol, with budgets isolated to this private process."""
    def __init__(self, device, identity):
        from importlib.metadata import version
        self.library_version = version('python-miio')
        if self.library_version != '0.5.12':
            raise Refused('unreviewed_miio_version')
        import miio
        from miio.miioprotocol import MiIOProtocol
        self.deadline = None
        self.expected = int(identity)
        self.device = miio.Device(device['localip'], device['token'], model=MODEL,
            start_id=secrets.randbelow(2**30) + 100, timeout=1)
        protocol = self.device._protocol
        discover = MiIOProtocol.discover
        MiIOProtocol.discover = staticmethod(lambda addr=None, timeout=5: discover(addr, timeout=min(timeout, self.deadline.remaining())))
        handshake = protocol.send_handshake
        protocol.send_handshake = lambda **_kwargs: handshake(retry_count=0)
        send = protocol.send

        def bounded_send(command, parameters=None, retry_count=0, **kwargs):
            if command not in ('get_prop', 'set_power'):
                raise Refused('method_not_allowed')
            self.deadline.remaining()
            if not protocol._discovered:
                protocol.send_handshake()
            protocol._timeout = self.deadline.remaining()
            return send(command, parameters, retry_count=0, **kwargs)
        protocol.send = bounded_send

    def identity(self, deadline):
        self.deadline = deadline
        deadline.remaining()
        if self.device.device_id != self.expected:
            raise Refused('network_identity_changed')

    def read(self, deadline):
        self.identity(deadline)
        result = self.device.send('get_prop', ['power'], retry_count=0)
        deadline.remaining()
        if not isinstance(result, list) or len(result) != 1 or result[0] not in ('on', 'off'):
            raise Refused('invalid_power_response')
        return result[0] == 'on'

    def write(self, value, deadline):
        self.identity(deadline)
        return self.device.send('set_power', ['on' if value else 'off'], retry_count=0)


class FixtureLamp:
    """File-backed fake physical state; never imports miio or opens a socket."""
    def __init__(self, path):
        self.path = path

    def state(self):
        return json.loads(self.path.read_text(encoding='utf-8'))

    def identity(self, deadline):
        deadline.remaining()

    def read(self, deadline):
        state = self.state()
        time.sleep(state.get('readDelayMs', 0) / 1000)
        deadline.remaining()
        return state['power']

    def write(self, value, deadline):
        state = self.state()
        time.sleep(state.get('beforeWriteDelayMs', 0) / 1000)
        deadline.remaining()
        state['power'] = value
        state['writes'] = state.get('writes', 0) + 1
        self.path.write_text(json.dumps(state), encoding='utf-8')
        time.sleep(state.get('afterWriteDelayMs', 0) / 1000)
        deadline.remaining()


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def line():
    raw = sys.stdin.buffer.readline(4097)
    if not raw:
        return None
    if len(raw) > 4096:
        raise Refused('rpc_too_large')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise Refused('invalid_rpc')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--expected-lamp-hash', required=True)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--mode', choices=['read-only', 'dry-run', 'execute'], default='read-only')
    parser.add_argument('--allow-write', action='store_true')
    parser.add_argument('--operation-limit-ms', type=float, required=True)
    parser.add_argument('--fixture', type=Path)
    args = parser.parse_args()
    home_hash, device, identity = inventory(args.workspace.resolve() / 'server/data/xiaomi-tokens.json', args.expected_lamp_hash)
    lock = OwnerLock(home_hash)
    resource = 'miio-lamp-' + args.expected_lamp_hash
    clock_id = str(uuid.uuid4())
    try:
        transport = FixtureLamp(args.fixture.resolve()) if args.fixture else RealLamp(device, identity)
        emit({'kind': 'ready', 'protocol': 1, 'ownerId': args.owner_id, 'homeHash': home_hash,
            'didHash': args.expected_lamp_hash, 'model': MODEL, 'resourceId': resource, 'mode': args.mode,
            'transport': 'fixture' if args.fixture else 'miio', 'clockId': clock_id})
        while True:
            request = line()
            if request is None:
                return 0
            request_id = request.get('id')
            started = time.perf_counter_ns()
            write_started = False
            try:
                if request.get('ownerId') != args.owner_id:
                    raise Refused('owner_mismatch')
                budget = request.get('remainingMs')
                if isinstance(budget, bool) or not isinstance(budget, (int, float)) or not 0 < budget <= args.operation_limit_ms:
                    raise Refused('invalid_budget')
                deadline = Deadline(budget)
                if request.get('kind') == 'read':
                    with contextlib.redirect_stdout(sys.stderr):
                        power = transport.read(deadline)
                    result = {'resourceId': resource, 'queryId': request.get('queryId'), 'fresh': True,
                        'properties': {'power': power}, 'networkIdentityVerified': not bool(args.fixture),
                        'fixtureOnly': bool(args.fixture),
                        'verificationLevel': 'protocol-property-query', 'physicalEffectVerified': False}
                elif request.get('kind') == 'write':
                    if args.mode != 'execute' or not args.allow_write:
                        raise Refused('actuation_disabled')
                    if not isinstance(request.get('value'), bool):
                        raise Refused('invalid_power_value')
                    if (not isinstance(request.get('commandId'), str) or not 0 < len(request['commandId']) <= 128
                            or type(request.get('goalVersion')) is not int or request['goalVersion'] < 1
                            or request.get('resourceId') != resource):
                        raise Refused('invalid_write_identity')
                    with contextlib.redirect_stdout(sys.stderr):
                        transport.identity(deadline)
                    binding = {'id': request_id, 'ownerId': args.owner_id, 'commandId': request['commandId'],
                               'goalVersion': request['goalVersion'], 'resourceId': resource}
                    emit({'kind': 'write-ready', **binding})
                    grant = line()
                    if not grant or grant != {'kind': 'authorize', **binding}:
                        raise Refused('write_not_authorized')
                    deadline.remaining()
                    write_started = True
                    with contextlib.redirect_stdout(sys.stderr):
                        transport.write(request['value'], deadline)
                    result = {'writeAcknowledged': True}
                elif request.get('kind') == 'preview':
                    result = {'actuationSent': False, 'resourceId': resource, 'property': 'power', 'value': request.get('value')}
                else:
                    raise Refused('unknown_rpc')
                emit({'kind': 'result', 'id': request_id, 'commandId': request.get('commandId'), 'ok': True, 'result': result, 'clockId': clock_id,
                    'durationMs': (time.perf_counter_ns() - started) / 1e6})
            except Exception as error:
                emit({'kind': 'result', 'id': request_id, 'commandId': request.get('commandId'), 'ok': False,
                    'error': {'code': str(error) if isinstance(error, Refused) else 'device_operation_failed',
                              'type': type(error).__name__, 'outcome': 'unknown' if write_started else 'not_started'}})
    finally:
        lock.close()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        emit({'kind': 'startup-error', 'code': str(error) if isinstance(error, Refused) else 'broker_start_failed',
              'errorType': type(error).__name__})
        raise SystemExit(1)
