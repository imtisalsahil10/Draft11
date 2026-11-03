"""One public Wikidata query for domestic-league statements of known clubs.

The club label must match exactly. No league is inferred from the club name
when this query fails or returns nothing.
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
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            time.sleep(5)
            return json.load(response)['results']['bindings']
    except urllib.error.HTTPError as error:
        print(f'wikidata {error.code}', file=sys.stderr)
        raise SystemExit(1)


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Pass the output path.')
    names = json.loads(sys.stdin.read())
    literals = ' '.join(json.dumps(name) + '@en' for name in names)
    query = f"""
SELECT ?club ?clubLabel ?leagueName ?start ?end WHERE {{
  VALUES ?clubLabel {{ {literals} }}
  ?club rdfs:label ?clubLabel;
        wdt:P31/wdt:P279* wd:Q476028.
  ?club p:P118 ?statement.
  ?statement ps:P118 ?league.
  ?league rdfs:label ?leagueName.
  FILTER(LANG(?leagueName) = "en")
  OPTIONAL {{ ?statement pq:P580 ?start. }}
  OPTIONAL {{ ?statement pq:P582 ?end. }}
}}
"""
    clubs = {name: {'matchCount': 0, 'ids': [], 'leagues': []} for name in names}
    for row in sparql(query):
        label = row.get('clubLabel', {}).get('value')
        bucket = clubs.get(label)
        if bucket is None:
            continue
        club_id = row.get('club', {}).get('value')
        if club_id and club_id not in bucket['ids']:
            bucket['ids'].append(club_id)
        league = row.get('leagueName', {}).get('value')
        if not league:
            continue
        entry = {
            'league': league,
            'start': row.get('start', {}).get('value'),
            'end': row.get('end', {}).get('value')
        }
        if entry not in bucket['leagues']:
            bucket['leagues'].append(entry)
    for bucket in clubs.values():
        bucket['matchCount'] = len(bucket['ids'])
        if bucket['matchCount'] != 1:
            bucket['leagues'] = []
    with open(sys.argv[1], 'w', encoding='utf-8') as handle:
        json.dump({
            'source': ENDPOINT,
            'license': 'CC0',
            'referenceDate': '2022-09-30',
            'clubs': clubs
        }, handle, indent=2)
    print(sys.argv[1])


if __name__ == '__main__':
    main()
