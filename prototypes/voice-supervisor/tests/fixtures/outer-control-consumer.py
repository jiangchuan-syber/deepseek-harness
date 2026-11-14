"""Real bridge generator and FlowTrace, isolated in an owned short-lived process."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--bridge', type=Path, required=True)
parser.add_argument('--config', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--after-unknown', default='')
args = parser.parse_args()
sys.path.insert(0, str(args.bridge.resolve()))
import voice_supervisor_backend as bridge
import flow_trace

# Only this fixture process changes the imported configuration path.
bridge.SETTINGS = args.config.resolve()
flow_trace.SETTINGS = args.config.resolve()
flow_options = {'async_io': True} if os.environ.get('VOICE_CONTROL_FLOW_ASYNC') == '1' else {}
flow = flow_trace.FlowTrace(args.output.with_suffix('.flow.jsonl'), **flow_options)
flow.start()
results = []
inputs = ('开灯',) if args.after_unknown else ('关灯', '开灯')
for index, text in enumerate(inputs):
    events = []
    until = time.monotonic() + 10
    voice = f'public-outer-voice-recovered-{index}' if args.after_unknown else f'public-outer-voice-{index}'
    replies = list(bridge.stream_supervisor(text, lambda: time.monotonic() >= until,
        on_event=lambda kind, **data: events.append({'kind': kind, **data}), voice_session_id=voice))
    request_id = next(e['supervisor_request'] for e in events if e['kind'] == 'supervisor')
    controls = [e['program_control'] for e in events if e['kind'] == 'program_control']
    assert replies == ['好的，我来处理。'], replies
    assert controls and controls[-1]['status'] == 'verified', controls
    assert controls[-1]['commandId'] == request_id
    assert controls[-1]['voiceSessionId'] == voice
    assert controls[-1]['goalVersion'] == (4 if args.after_unknown else index + 1)
    assert controls[-1]['currentGoal'] is True
    assert not any(e.get('voice_role') == 'answer' for e in events)
    while time.monotonic() < until:
        snapshot = flow.snapshot()
        seen = [e for e in snapshot['events'] if e.get('kind') == 'control.verified'
                and e.get('requestId') == request_id and e.get('voiceSessionId') == voice]
        if seen:
            break
        time.sleep(.02)
    assert seen, 'Actual FlowTrace did not consume the outer trace'
    assert any(c['commandId'] == request_id for c in snapshot['programControls'])
    assert snapshot['engineState']['status'] == 'running', 'Max fixture must remain busy'
    results.append({'requestId': request_id, 'voiceSessionId': voice, 'replies': replies,
                    'fact': controls[-1], 'flowEvent': seen[-1]})
    if args.after_unknown:
        from program_control import exact_result, for_request
        config = json.loads(args.config.read_text(encoding='utf-8'))
        raw = bridge.request(config, '/control-result?commandId=' + args.after_unknown)
        old = exact_result(raw, args.after_unknown, 'public-outer-unknown', raw['sourceInstance'])
        assert old and old['status'] == 'unknown' and not old['currentGoal']
        assert old['goalVersion'] == 3 and old['commandId'] != request_id
        assert exact_result(raw, request_id, voice, raw['sourceInstance']) is None
        assert for_request({'controls': [old]}, request_id, voice) is None
        assert all(e.get('voiceSessionId') == 'public-outer-unknown' for e in snapshot['events']
                   if e.get('kind', '').startswith('control.') and e.get('requestId') == args.after_unknown)
        results[-1]['oldUnknownFact'] = old
if flow_options:
    assert flow.close(timeout=2), 'Owned asynchronous observer did not close cleanly'
args.output.write_text(json.dumps({'status': 'PASS', 'flowAsync': bool(flow_options), 'cases': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
