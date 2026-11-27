"""压缩信号读取的离线测试（stdlib unittest，不依赖 pytest、不读真实宿主数据）。

运行： python -m unittest discover -s tests/python -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages' / 'swarm-hosts' / 'python'))

from compact_signal import acp_compact, codex_compaction_records, compact_estimate, qoder_compaction_records


class CodexRolloutTest(unittest.TestCase):
    def test_counts_compacted_records_and_splits_live_replay(self):
        thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '2026' / '11' / '20').mkdir(parents=True)
            path = root / '2026' / '11' / '20' / ('rollout-2026-11-20T00-25-17-%s.jsonl' % thread)
            rows = [
                {'timestamp': '2026-11-20T01:00:00.000Z', 'ordinal': 10, 'type': 'compacted', 'payload': {}},
                {'timestamp': '2026-11-20T02:00:00.000Z', 'ordinal': 20, 'type': 'item_completed', 'payload': {}},
                {'timestamp': '2026-11-20T03:00:00.000Z', 'ordinal': 30, 'type': 'compacted', 'payload': {}},
            ]
            path.write_text('\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')

            found = codex_compaction_records(thread, since_iso='2026-11-20T02:30:00.000Z', root=str(root))
            self.assertEqual(len(found), 2)
            self.assertEqual([r['path'] for r in found], ['replay', 'live'])
            self.assertEqual(found[1]['message_id'], 'codex-compact:%s:30' % thread)
            self.assertTrue(all(r['confirmed'] and r['phase'] == 'done' for r in found))

    def test_compact_uses_nearest_pre_sample_and_publishes_only_fresh_post_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            def row(stamp, used):
                return {'timestamp': stamp, 'type': 'event_msg', 'payload': {'type': 'token_count',
                    'info': {'last_token_usage': {'total_tokens': used}, 'model_context_window': 475000}}}
            path = Path(tmp) / 'rollout-2026-11-20-thread-id.jsonl'
            records = [row('2026-11-20T02:00:00Z', 447450),
                       {'timestamp': '2026-11-20T02:00:01.000Z', 'ordinal': 32, 'type': 'compacted'},
                       row('2026-11-20T02:00:02Z', 49210)]
            path.write_text('\n'.join(map(json.dumps, records)), encoding='utf8')
            result = codex_compaction_records('thread-id', '2026-11-20T02:00:01.000000Z', root=tmp, emit_usage=True)
            self.assertEqual(result[0]['path'], 'live')
            self.assertEqual((result[0]['baseline_used'], result[0]['baseline_size']), (447450, 475000))
            self.assertEqual(result[1]['context_used'], 49210)

    def test_missing_rollout_is_empty_not_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(codex_compaction_records('no-such-thread', root=tmp), [])
        self.assertEqual(codex_compaction_records('', ), [])


class QoderTranscriptTest(unittest.TestCase):
    def test_counts_compact_boundary(self):
        session = '1111-2222'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / 'proj'
            project.mkdir()
            path = project / ('%s.jsonl' % session)
            rows = [
                {'type': 'system', 'subtype': 'compact_boundary', 'uuid': 'u1', 'timestamp': '2026-11-19T07:06:16.450Z'},
                {'type': 'user', 'uuid': 'u2', 'isCompactSummary': True, 'timestamp': '2026-11-19T07:06:16.450Z'},
                {'type': 'assistant', 'uuid': 'u3', 'timestamp': '2026-11-19T08:00:00.000Z'},
            ]
            path.write_text('\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')

            found = qoder_compaction_records(session, root=str(root))
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]['message_id'], 'qoder-compact:%s:u1' % session)

    def test_acp_session_without_transcript_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(qoder_compaction_records('no-such-session', root=tmp), [])


class AcpCompactTest(unittest.TestCase):
    def _frame(self, meta, content=''):
        return {
            'sessionUpdate': 'agent_message_chunk',
            'messageId': 'compact-maxtoken-s1-1',
            'content': {'type': 'text', 'text': content},
            '_meta': meta,
        }

    def test_start_and_done(self):
        meta = {'codebuddy.ai/isCompactInternal': True, 'codebuddy.ai/compactType': 'auto'}
        start = acp_compact(self._frame(meta, '<conversation_history_summary><summary>'), 'CodeBuddy', replaying=False)
        self.assertEqual(start['phase'], 'start')
        self.assertEqual(start['compact_type'], 'auto')
        done = acp_compact(self._frame(meta, '</conversation_history_summary>'), 'CodeBuddy', replaying=False)
        self.assertEqual(done['phase'], 'done')
        replay = acp_compact(self._frame(meta, '</conversation_history_summary>'), 'CodeBuddy', replaying=True)
        self.assertEqual(replay['path'], 'replay')

    def test_limit_and_cancel(self):
        limit = acp_compact({
            'sessionUpdate': 'session_info_update',
            '_meta': {'codebuddy.ai/compact-limit-reached': {'limitReached': True}},
        }, 'CodeBuddy', replaying=False)
        self.assertEqual(limit['phase'], 'limit')
        cancel = acp_compact({
            'sessionUpdate': 'session_info_update',
            '_meta': {'codebuddy.ai/compact-cancelled': {'cancelled': True}},
        }, 'CodeBuddy', replaying=False)
        self.assertEqual(cancel['phase'], 'cancelled')

    def test_ordinary_chunk_is_ignored(self):
        self.assertIsNone(acp_compact({
            'sessionUpdate': 'agent_message_chunk',
            'messageId': 'm1',
            'content': {'type': 'text', 'text': 'hello'},
            '_meta': {},
        }, 'CodeBuddy', replaying=False))


class EstimateTest(unittest.TestCase):
    def test_ratio_with_host_budget(self):
        got = compact_estimate({'context_used': 300000, 'context_size': 400000}, 1000000)
        self.assertAlmostEqual(got['ratio'], 0.3)
        self.assertEqual(got['path'], 'estimate')
        self.assertFalse(got['confirmed'])

    def test_falls_back_to_reported_size(self):
        got = compact_estimate({'context_used': 37214, 'context_size': 1048576}, 0)
        self.assertAlmostEqual(got['ratio'], 0.0355, places=4)

    def test_no_usage_is_none(self):
        self.assertIsNone(compact_estimate({'context_used': None, 'context_size': None}, 0))


if __name__ == '__main__':
    unittest.main()
