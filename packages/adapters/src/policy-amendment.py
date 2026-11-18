"""Exact person-scoped source revisions. No approval, solver or ledger mutation."""
import base64
import copy
import json
import re
import sys


def compare_amendment(before, after, changes):
    if not isinstance(changes, list) or not 1 <= len(changes) <= 20:
        raise ValueError('Select 1-20 exact person/rule changes')
    expected = copy.deepcopy(before)
    rules = {row['id']: row for row in expected['rules']}
    if len(rules) != len(expected['rules']):
        raise ValueError('Duplicate rule identity')
    seen = set()
    for change in changes:
        fields = {'ruleId', 'personId', 'action'} | ({'value'} if change.get('action') == 'quota' else set())
        if set(change) != fields or change['action'] not in ('exclude', 'quota'):
            raise ValueError('Unsupported amendment')
        for key in ('ruleId', 'personId'):
            if not isinstance(change[key], str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', change[key]):
                raise ValueError('Use exact compiler rule/person identifiers')
        name = change['ruleId']
        if name in seen or name not in rules:
            raise ValueError('Select each known rule once per amendment')
        seen.add(name)
        rule = rules[name]
        if rule['tier'] != 'hard' or len(rule['body']) != 1 or rule['body'][0].get('kind') != 'for_each':
            raise ValueError('A hard rule with one outer person iteration is required')
        loop = rule['body'][0]
        person = change['personId']
        if person == loop['var']:
            raise ValueError('Person identity is shadowed by the iteration variable')
        original = loop['body']
        # The compiler records the first comparison as repair-direction metadata.
        # The new outer guard is necessarily !=; the original constraint is unchanged.
        if 'op' in rule:
            rule['op'] = '!='
        # Compiler type checks the person constant and its comparison to the iterator.
        def guard(op, body):
            return {'kind': 'if_then', 'cond': {'kind': 'cmp', 'op': op,
                'lhs': {'kind': 'name', 'value': loop['var']},
                'rhs': {'kind': 'name', 'value': person}}, 'body': body}
        loop['body'] = [guard('!=', original)]
        if change['action'] == 'quota':
            value = change['value']
            if type(value) is not int or not 0 <= value <= 1_000_000:
                raise ValueError('Quota must be an exact finite nonnegative integer')
            revised = copy.deepcopy(original)
            if len(revised) != 1 or revised[0].get('kind') != 'constraint':
                raise ValueError('A single count quota is required')
            expr = revised[0]['expr']
            if (expr.get('kind') != 'cmp' or expr.get('op') not in ('==', '<=', '>=')
                    or expr.get('lhs', {}).get('kind') != 'count' or expr.get('rhs', {}).get('kind') != 'int'
                    or type(expr['rhs'].get('value')) is not int or expr['rhs']['value'] == value):
                raise ValueError('Only the selected count quota bound may change')
            expr['rhs']['value'] = value
            loop['body'].append(guard('==', revised))
    def without_locations(ir):
        result = copy.deepcopy(ir)
        for row in result['rules']:
            row.pop('source_line', None)
        return result
    if without_locations(expected) != without_locations(after):
        raise ValueError('Candidate changes more than the exact selected person/rule scope')


def run(request, library, source_review):
    if request['operation'] != 'capture_amendment':
        raise ValueError('Unsupported amendment operation')
    capture = {key: request[key] for key in ('baseline', 'baselineWorkingDirectory', 'policy', 'workingDirectory')}
    snapshot = source_review({**capture, 'operation': 'capture'}, library)
    work = library['Workbench']()
    checked = library['checked_path']
    def ir(key, cwd_key):
        return json.loads(work.command(['emit', str(checked(work.root, request[key])), '--format', 'ir'],
                                      checked(work.root, request[cwd_key], True)))
    compare_amendment(ir('baseline', 'baselineWorkingDirectory'), ir('policy', 'workingDirectory'), request['changes'])
    def data_pins(value):
        return [pin for pin in value['inputs'] if pin.get('kind') != 'rule_presentation']
    if data_pins(snapshot['baseline']) != data_pins(snapshot['candidate']):
        raise ValueError('Person amendments cannot also change operational input data')
    if source_review({**capture, 'operation': 'capture'}, library) != snapshot:
        raise ValueError('Amendment source or inputs changed during review')
    return {**snapshot, 'amendments': request['changes'], 'assurance': 'exact_compiler_ir_person_scope',
            'backgroundSupported': True, 'feasibilityEstablished': False}


if __name__ == '__main__':
    try:
        library = {'__name__': 'pinned_policy_library'}
        exec(compile(base64.b64decode(sys.argv[2], validate=True), 'pinned-library', 'exec'), library)
        source_review = {'__name__': 'pinned_source_review'}
        exec(compile(base64.b64decode(sys.argv[3], validate=True), 'pinned-source-review', 'exec'), source_review)
        print(json.dumps(run(json.loads(base64.b64decode(sys.argv[1], validate=True)), library,
                             source_review['run']), ensure_ascii=True, allow_nan=False))
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else 'Person amendment review failed; no policy was applied or solve started.'}))
        sys.exit(1)
