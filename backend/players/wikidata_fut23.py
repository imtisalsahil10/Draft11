"""Fetch exact-name association football players from the public Wikidata SPARQL service.

Lookups are split so a player with a long club history does not time the name
query out. Missing names are stored with matchCount 0. The endpoint's published
SPARQL access is the only request made.
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = 'https://query.wikidata.org/sparql'
USER_AGENT = 'Draft11IdentityVerification/1.0 (local historical catalogue)'


def sparql(text):
    url = ENDPOINT + '?format=json&query=' + urllib.parse.quote(text)
    request = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'application/sparql-results+json'
    })
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                time.sleep(5)
                return json.load(response)['results']['bindings']
        except urllib.error.HTTPError as error:
            attempt += 1
            if attempt > 4:
                raise
            wait = 70
            if error.headers and error.headers.get('Retry-After', '').isdigit():
                wait = min(120, max(70, int(error.headers.get('Retry-After'))))
            print(f'retry {error.code} in {wait}s', file=sys.stderr)
            time.sleep(wait)


def values(items):
    return ' '.join(json.dumps(item) for item in items)


def blank(key):
    return {
        'key': key,
        'matchCount': 0,
        'ids': [],
        'labels': [],
        'citizenships': [],
        'positions': [],
        'aliases': [],
        'memberships': []
    }


def add(bucket, field, value, limit=12):
    if value and value not in bucket[field] and len(bucket[field]) < limit:
        bucket[field].append(value)


PARTICLES = {'da', 'de', 'del', 'der', 'di', 'do', 'dos', 'du', 'la', 'le', 'van', 'von', 'bin', 'al'}


def label_variants(key):
    tokens = key.split(' ')
    titled = [token[:1].upper() + token[1:] for token in tokens]
    softened = [
        token if index and token in PARTICLES else token[:1].upper() + token[1:]
        for index, token in enumerate(tokens)
    ]
    return { ' '.join(titled), ' '.join(softened) }


def identity_query(keys):
    labels = sorted({variant for key in keys for variant in label_variants(key)})
    literals = ' '.join(json.dumps(label) + '@en' for label in labels)
    return f"""
SELECT ?player ?label ?citizenshipLabel ?positionLabel WHERE {{
  VALUES ?label {{ {literals} }}
  ?player wdt:P31 wd:Q5;
          wdt:P106 wd:Q937857;
          rdfs:label ?label.
  OPTIONAL {{ ?player wdt:P27 ?citizenship. }}
  OPTIONAL {{ ?player wdt:P413 ?position. }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""


def membership_query(ids):
    iris = ' '.join(f'<{item}>' for item in ids)
    return f"""
SELECT ?player ?clubLabel ?start ?end WHERE {{
  VALUES ?player {{ {iris} }}
  ?player p:P54 ?membership.
  ?membership ps:P54 ?club.
  OPTIONAL {{ ?membership pq:P580 ?start. }}
  OPTIONAL {{ ?membership pq:P582 ?end. }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""


def alias_query(ids):
    iris = ' '.join(f'<{item}>' for item in ids)
    return f"""
SELECT ?player ?alias WHERE {{
  VALUES ?player {{ {iris} }}
  ?player skos:altLabel ?alias.
  FILTER(LANG(?alias) = "en")
}}
"""


def write_cache(path, players):
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump({
            'source': ENDPOINT,
            'license': 'CC0',
            'referenceDate': '2022-09-30',
            'players': players
        }, handle)


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Pass the cache path.')
    cache_path = sys.argv[1]
    names = json.loads(sys.stdin.read())
    players = {key: blank(key) for key in names}
    if __import__('os').path.exists(cache_path) and __import__('os').path.getsize(cache_path) > 2:
        existing = json.load(open(cache_path, encoding='utf-8')).get('players', {})
        for key, value in existing.items():
            if key in players and value.get('identityFetched'):
                players[key] = value
    pending = [key for key in names if not players[key].get('identityFetched')]
    for index in range(0, len(pending), 40):
        batch = pending[index:index + 40]
        for row in sparql(identity_query(batch)):
            key = row.get('label', {}).get('value', '').lower()
            bucket = players.get(key)
            if bucket is None:
                continue
            add(bucket, 'ids', row.get('player', {}).get('value'), 8)
            add(bucket, 'labels', row.get('label', {}).get('value'), 4)
            add(bucket, 'citizenships', row.get('citizenshipLabel', {}).get('value'))
            add(bucket, 'positions', row.get('positionLabel', {}).get('value'))
        for key in batch:
            players[key]['identityFetched'] = True
            players[key]['matchCount'] = len(players[key]['ids'])
            if players[key]['matchCount'] != 1:
                players[key]['citizenships'] = []
                players[key]['positions'] = []
        print(f'names {index + len(batch)}/{len(pending)}', file=sys.stderr)
        write_cache(cache_path, players)

    id_to_buckets = {}
    for bucket in players.values():
        if bucket.get('matchCount') == 1 and not bucket.get('clubsFetched'):
            id_to_buckets.setdefault(bucket['ids'][0], []).append(bucket)
    unique_ids = list(id_to_buckets)
    for index in range(0, len(unique_ids), 15):
        batch = unique_ids[index:index + 15]
        for row in sparql(membership_query(batch)):
            player_id = row.get('player', {}).get('value')
            club = row.get('clubLabel', {}).get('value')
            if not club:
                continue
            membership = {
                'club': club,
                'start': row.get('start', {}).get('value'),
                'end': row.get('end', {}).get('value')
            }
            for bucket in id_to_buckets.get(player_id, []):
                if membership not in bucket['memberships']:
                    bucket['memberships'].append(membership)
        for player_id in batch:
            for bucket in id_to_buckets.get(player_id, []):
                bucket['clubsFetched'] = True
        print(f'clubs {min(index + len(batch), len(unique_ids))}/{len(unique_ids)}', file=sys.stderr)
        write_cache(cache_path, players)
    for bucket in players.values():
        if bucket.get('matchCount') != 1:
            bucket['clubsFetched'] = True
            bucket['aliasesFetched'] = True
    alias_ids = []
    alias_targets = {}
    for bucket in players.values():
        if bucket.get('matchCount') == 1 and not bucket.get('aliasesFetched'):
            alias_targets.setdefault(bucket['ids'][0], []).append(bucket)
    alias_ids = list(alias_targets)
    for index in range(0, len(alias_ids), 25):
        batch = alias_ids[index:index + 25]
        for row in sparql(alias_query(batch)):
            player_id = row.get('player', {}).get('value')
            alias = row.get('alias', {}).get('value')
            for bucket in alias_targets.get(player_id, []):
                add(bucket, 'aliases', alias, 8)
        for player_id in batch:
            for bucket in alias_targets.get(player_id, []):
                bucket['aliasesFetched'] = True
        print(f'aliases {min(index + len(batch), len(alias_ids))}/{len(alias_ids)}', file=sys.stderr)
        write_cache(cache_path, players)
    write_cache(cache_path, players)
    print(cache_path)


if __name__ == '__main__':
    main()
