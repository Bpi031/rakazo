import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('amendment', Path(__file__).with_name('policy-amendment.py'))
amendment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amendment)


def fixture(action='exclude'):
    body = [{'kind': 'constraint', 'expr': {'kind': 'cmp', 'op': '==',
        'lhs': {'kind': 'count', 'comp': {'var': 'd', 'domain': 'days', 'filter': {'kind': 'assigned', 'person': 'p'}}},
        'rhs': {'kind': 'int', 'value': 4}}}]
    before = {'staff': [{'id': 'Scott'}, {'id': 'Alice'}], 'rules': [
        {'id': 'quota', 'tier': 'hard', 'op': '==', 'source_line': 10, 'body': [
            {'kind': 'for_each', 'var': 'p', 'domain': 'people', 'body': body}]},
        {'id': 'rest', 'tier': 'hard', 'source_line': 14, 'body': []}], 'objective': ['unchanged']}
    after = copy.deepcopy(before)
    after['rules'][0]['op'] = '!='
    loop = after['rules'][0]['body'][0]
    guard = lambda op, inner: {'kind': 'if_then', 'cond': {'kind': 'cmp', 'op': op,
        'lhs': {'kind': 'name', 'value': 'p'}, 'rhs': {'kind': 'name', 'value': 'Scott'}}, 'body': inner}
    loop['body'] = [guard('!=', copy.deepcopy(body))]
    change = {'ruleId': 'quota', 'personId': 'Scott', 'action': action}
    if action == 'quota':
        revised = copy.deepcopy(body)
        revised[0]['expr']['rhs']['value'] = 3
        loop['body'].append(guard('==', revised))
        change['value'] = 3
    after['rules'][1]['source_line'] = 20
    return before, after, [change]


class AmendmentTests(unittest.TestCase):
    def test_exact_exclusion_and_quota(self):
        for action in ('exclude', 'quota'):
            amendment.compare_amendment(*fixture(action))

    def test_unselected_semantic_changes_fail(self):
        for mutation in ('person', 'rest', 'objective', 'other_body', 'domain', 'comparison', 'staff', 'remove_rule'):
            with self.subTest(mutation=mutation):
                before, after, changes = fixture('quota')
                loop = after['rules'][0]['body'][0]
                if mutation == 'person': loop['body'][0]['cond']['rhs']['value'] = 'Alice'
                if mutation == 'rest': after['rules'][1]['tier'] = 'soft'
                if mutation == 'objective': after['objective'] = ['changed']
                if mutation == 'other_body': loop['body'][0]['body'][0]['expr']['rhs']['value'] = 2
                if mutation == 'domain': loop['domain'] = 'other_group'
                if mutation == 'comparison': loop['body'][1]['body'][0]['expr']['op'] = '<='
                if mutation == 'staff': after['staff'].pop()
                if mutation == 'remove_rule': after['rules'].pop()
                with self.assertRaises(ValueError): amendment.compare_amendment(before, after, changes)

    def test_invalid_selections_fail_closed(self):
        for value in (-1, True, 1.5, 1_000_001, 4):
            before, after, changes = fixture('quota')
            changes[0]['value'] = value
            with self.assertRaises(ValueError): amendment.compare_amendment(before, after, changes)
        before, after, changes = fixture()
        with self.assertRaises(ValueError): amendment.compare_amendment(before, after, changes * 2)
        changes[0]['personId'] = 'p'
        with self.assertRaises(ValueError): amendment.compare_amendment(before, after, changes)

    def test_only_native_hard_iterated_rules(self):
        for mutation in ('soft', 'siblings', 'non_iteration'):
            before, after, changes = fixture()
            if mutation == 'soft': before['rules'][0]['tier'] = 'soft'
            if mutation == 'siblings': before['rules'][0]['body'] *= 2
            if mutation == 'non_iteration': before['rules'][0]['body'][0]['kind'] = 'sequence'
            with self.assertRaises(ValueError): amendment.compare_amendment(before, after, changes)


if __name__ == '__main__': unittest.main()
