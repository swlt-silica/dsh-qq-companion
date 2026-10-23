"""Standalone ATRI HTML adapter. Python 3 + Jinja2; no AstrBot/network/browser.

Templates are copied verbatim from the installed SXP-Simon plugin v5.8.1,
with its MIT license alongside. Unsafe partial-template `safe` filters are
disabled here. Only the composed, already escaped HTML fragments are trusted.
AstrBot's html_render image service is deliberately not imported or emulated.
"""
import json
import re
import sys
from pathlib import Path
from jinja2 import Environment, FileSystemLoader
from markupsafe import Markup


def clean_offline_html(html):
    """Drop unavailable decorative images without altering upstream templates.

    Input is the already escaped, trusted-template document, not arbitrary HTML.
    Inline data images remain available under the offline CSP.
    """
    def image(match):
        source = re.search(r'\bsrc\s*=\s*([\'"])(.*?)\1', match.group(0), re.I | re.S)
        return match.group(0) if source and source.group(2).lower().startswith('data:') else ''
    html = re.sub(r'<img\b[^>]*>', image, html, flags=re.I | re.S)
    # No remote font retries, missing backgrounds or accidental file:// reads.
    html = re.sub(r'@font-face\s*\{[^}]*\}', '', html, flags=re.I | re.S)
    def asset_url(match):
        value = match.group(0)[4:-1].strip().strip('\'"')
        return match.group(0) if value.lower().startswith('data:') else 'none'
    html = re.sub(r'url\([^)]*\)', asset_url, html, flags=re.I)
    return html


def render_report(data):
    root = Path(__file__).parent / 'report-templates' / 'ATRI'
    env = Environment(loader=FileSystemLoader(root), autoescape=True)
    base = data.get('assetBase', '')
    if base and not re.fullmatch(r'https://[A-Za-z0-9./_@-]+', base):
        raise ValueError('Invalid trusted asset base')
    common = dict(t2i_atri_font_mirror=base, t2i_font_source='Mainland')

    def partial(name, **kwargs):
        # Model strings must never reach Jinja's safe filter in upstream partials.
        source = (root / name).read_text(encoding='utf-8')
        source = re.sub(r'\|\s*safe\b', '|e', source)
        return Markup(env.from_string(source).render(**common, **kwargs))

    analysis, counts = data['analysis'], data['counts']
    topics = [dict(index=i+1, topic=t, contributors='、'.join(t['contributors']), detail=t['detail'])
              for i, t in enumerate(analysis['topics'])]
    hourly = counts['hourly']
    peak = max(hourly, default=0)
    chart = [dict(hour=f'{hour:02d}', count=count,
                  height=round(count / peak * 100) if peak else 0)
             for hour, count in enumerate(hourly)]
    context = dict(common, current_date=data['date'], current_datetime=data['date']+' 21:00 UTC+8',
                   message_count=counts['messages'], participant_count=counts['participants'],
                   total_characters=counts['characters'], emoji_count='未提供',
                   most_active_period=f'{hourly.index(peak):02d}:00' if peak else '无消息',
                   prompt_tokens='未提供', completion_tokens='未提供', total_tokens='未提供',
                   topics_html=partial('topic_item.html', topics=topics),
                   titles_html=partial('user_title_item.html', titles=analysis['user_titles']),
                   quotes_html=partial('quote_item.html', quotes=analysis['golden_quotes']),
                   chat_quality_html=partial('chat_quality_item.html', **analysis['chat_quality']),
                   hourly_chart_html=partial('activity_chart.html', chart_data=chart))
    html = env.get_template('html_template.html').render(**context)
    if not base:
        html = clean_offline_html(html)
    # Prevent remote asset loading in the default offline artifact. A deployment
    # may opt into its trusted existing ATRI asset mirror without model control.
    policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'"
    if base:
        origin = '/'.join(base.split('/')[:3])
        policy = f"default-src 'none'; style-src 'unsafe-inline'; img-src data: {origin}; font-src {origin}; base-uri 'none'; form-action 'none'"
    return html.replace('<head>', '<head>\n<meta http-equiv="Content-Security-Policy" content="'+policy+'">', 1)


if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdout.write(render_report(json.load(sys.stdin)))
