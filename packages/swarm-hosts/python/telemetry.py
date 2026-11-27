"""Display only provider-reported metrics, never infer billing from tokens."""
import math

SHARED_POOL='CodeBuddy / WorkBuddy 共享积分'
POOL_LABELS={'CodeBuddy':SHARED_POOL,'WorkBuddy':SHARED_POOL}
# Only these keys are per-call usage. Context size is a session figure, not a cost.
USAGE_KEYS=('input_tokens','output_tokens','reasoning_tokens','cache_read_tokens','cache_write_tokens')
DISPLAY_FIELDS=[('input_tokens','输入'),('output_tokens','输出'),('reasoning_tokens','思考'),
                ('cache_read_tokens','缓存读'),('cache_write_tokens','缓存写')]


def number(value, integer=False):
    return (type(value) is int if integer else type(value) in (int,float)) and value >= 0 and math.isfinite(value)


def acp_usage(update, provider=''):
    data={'source':'ACP usage_update','scope':'session'}
    if update.get('used')==0 and update.get('size')==0:
        data['context_empty_report']=True
    elif number(update.get('used'),True):data['context_used']=update['used']
    if number(update.get('size'),True) and update['size']>0:data['context_size']=update['size']
    if 'cost' in update:
        cost=update['cost']
        data['cost']=None
        if (isinstance(cost,dict) and number(cost.get('amount')) and isinstance(cost.get('currency'),str)
                and len(cost['currency'])<=16):
            data['cost']={'amount':cost['amount'],'currency':cost['currency'].upper(),'scope':'session'}
            if provider=='CodeBuddy':data['cost']['scope']='event'
    # These vendor keys are verified in the installed CodeBuddy ACP publisher.
    # cost.amount with currency="" alone is NOT sufficient evidence of credits.
    if provider == 'CodeBuddy':
        meta=update.get('_meta')
        if isinstance(meta,dict):
            credits=meta.get('codebuddy.ai/requestCredits')
            if isinstance(credits,dict):
                valid={k:v for k,v in credits.items() if isinstance(k,str) and len(k)<=128 and number(v)}
                if valid:data.update(request_credits=valid,credit_source='CodeBuddy ACP requestCredits')
            rid=meta.get('codebuddy.ai/conversationRequestId')
            if isinstance(rid,str) and len(rid)<=128:data['credit_request_id']=rid
    return data if len(data)>2 else {}


def merge_usage(target, update):
    credits=dict(target.get('request_credits',{}))
    credits.update(update.get('request_credits',{}))
    target.update(update)
    if credits:target['request_credits']=credits
    return target


def request_credit(data):
    credits=data.get('request_credits',{})
    rid=data.get('credit_request_id')
    if rid in credits:return credits[rid]
    if len(credits)==1:return next(iter(credits.values()))
    return None


def reply_footer(data):
    parts=[]
    credit=request_credit(data)
    if credit is not None:parts.append(f'积分 {credit:g}（本次请求累计）')
    elif data.get('request_credits'):parts.append('积分：多轮数据待匹配')
    else:parts.append('积分未提供')
    for key,label in [('input_tokens','输入'),('output_tokens','输出'),('reasoning_tokens','思考'),
                      ('cache_read_tokens','缓存读'),('total_tokens','总 Token')]:
        if key in data:parts.append(f'{label} {data[key]:,}')
    used,size=data.get('context_used'),data.get('context_size')
    if used is not None and size:parts.append(f'上下文 {used:,}/{size:,} ({used/size:.0%})')
    elif used is not None:parts.append(f'上下文 {used:,}（上限未提供）')
    else:parts.append('上下文未提供')
    cost=data.get('cost')
    if credit is None and cost:
        parts.append(f"平台计量 {cost['amount']:g} {cost['currency'] or '（单位未提供）'}")
    return ' · '.join(parts)


def token_usage(usage, source):
    if not isinstance(usage,dict):return {}
    aliases={'input_tokens':('inputTokens','input_tokens','promptTokenCount'),
             'output_tokens':('outputTokens','output_tokens','candidatesTokenCount'),
             'total_tokens':('totalTokens','total_tokens','totalTokenCount'),
             'reasoning_tokens':('thoughtTokens','reasoning_tokens','thinking_tokens','thoughtsTokenCount','reasoning_output_tokens'),
             'cache_read_tokens':('cachedReadTokens','cache_read_tokens','cache_read_input_tokens','cachedContentTokenCount','cached_input_tokens'),
             'cache_write_tokens':('cachedWriteTokens','cache_creation_input_tokens')}
    data={}
    for key,names in aliases.items():
        for name in names:
            if number(usage.get(name),True):data[key]=usage[name];break
    if data:data.update(token_source=source,token_scope='provider_unspecified')
    return data


def usage_text(data):
    used,size=data.get('context_used'),data.get('context_size')
    if used is not None and size:
        context=f'{used:,} / {size:,} ({used/size:.1%})'
    elif used is not None:context=f'{used:,} · 上限未提供'
    elif size:context=f'上限 {size:,} · 已用未提供'
    else:context='未提供有效值（客户端返回 0/0）' if data.get('context_empty_report') else '未提供'
    tokens=[]
    for key,label in [('input_tokens','输入'),('output_tokens','输出'),('reasoning_tokens','思考'),
                      ('cache_read_tokens','缓存读取'),('cache_write_tokens','缓存写入'),('total_tokens','总计')]:
        if key in data:tokens.append(f"{label} {data[key]:,}")
    cost=data.get('cost')
    money=(f"{cost['amount']:g} {cost['currency'] or '（单位未提供）'} · "
           +('本次计量事件' if cost.get('scope')=='event' else '会话累计')) if cost else '未提供'
    credits=(f"{cost['amount']:g}（会话累计）" if cost and cost['currency'] in ('CREDIT','CREDITS','POINT','POINTS') else '未提供')
    reported_credit=request_credit(data)
    if reported_credit is not None:credits=f'{reported_credit:g}（本次请求累计）'
    return (f'上下文：{context}\nToken：'+(' · '.join(tokens)+'（客户端报告，统计范围未声明）' if tokens else '未提供')
            +f'\n费用/平台计量：{money}\n积分消耗：{credits}')


# One task run keeps a bucket per actual model call, so repeated provider updates
# for the same call are not billed twice and shared pools are summed once.

def pool_of(platform):
    return POOL_LABELS.get(platform,platform or '未标注平台')


def usage_call(store,node_id,platform):
    calls=store.setdefault('calls',[]);calls.append(dict(node=node_id,platform=platform,
        reports=[],fields={},credits={},costs={}))
    store.setdefault('open',{})[str(node_id)]=len(calls)-1


def usage_observe(store,node_id,platform,data):
    """Record one provider usage report inside the call that is currently open."""
    if not isinstance(data,dict):return
    calls=store.setdefault('calls',[]);index=store.get('open',{}).get(str(node_id))
    if not isinstance(index,int) or index>=len(calls) or calls[index]['node']!=node_id:
        usage_call(store,node_id,platform);index=len(calls)-1
    call=calls[index]
    fields={key:data[key] for key in USAGE_KEYS if number(data.get(key),True)}
    signature=sorted(fields.items())
    # A client may resend the same figures for one call; identical reports count once.
    if fields and signature not in call['reports']:
        call['reports'].append(signature)
        for key,value in fields.items():call['fields'][key]=call['fields'].get(key,0)+value
    for rid,amount in (data.get('request_credits') or {}).items():
        if isinstance(rid,str) and number(amount):call['credits'][rid]=max(call['credits'].get(rid,0),amount)
    cost=data.get('cost')
    if isinstance(cost,dict) and number(cost.get('amount')):
        currency=cost.get('currency') if isinstance(cost.get('currency'),str) else ''
        call['costs'][currency]=max(call['costs'].get(currency,0),cost['amount'])


def usage_pools(store,node_id=None):
    """Aggregate recorded calls by platform, merging CodeBuddy and WorkBuddy into one pool."""
    pools={}
    for call in (store or {}).get('calls') or []:
        if node_id is not None and call.get('node')!=node_id:continue
        entry=pools.setdefault(pool_of(call.get('platform')),
            dict(calls=0,fields={},reported={},credits={},costs={}))
        entry['calls']+=1
        for key,value in (call.get('fields') or {}).items():
            entry['fields'][key]=entry['fields'].get(key,0)+value
            entry['reported'][key]=entry['reported'].get(key,0)+1
        for rid,amount in (call.get('credits') or {}).items():
            entry['credits'][rid]=max(entry['credits'].get(rid,0),amount)
        for currency,amount in (call.get('costs') or {}).items():
            entry['costs'][currency]=max(entry['costs'].get(currency,0),amount)
    return pools


def figure(value):
    return f'{value:,.0f}' if abs(value-round(value))<1e-9 else f'{value:,.2f}'


def settle_text(entry):
    credits=entry.get('credits') or {}
    if credits:return '扣减积分 '+figure(sum(credits.values()))
    costs=entry.get('costs') or {}
    if costs:return '平台计量 '+'、'.join(f'{figure(amount)} {currency or "（币种未提供）"}'
                                       for currency,amount in costs.items())
    return '扣减积分/费用 未提供'


def compact_line(entry):
    parts=[f'调用 {entry["calls"]} 次'];missing=[];partial=False
    for key,label in DISPLAY_FIELDS:
        if key in entry['fields']:
            parts.append(f'{label} {figure(entry["fields"][key])}')
            if entry['reported'].get(key,0)<entry['calls']:partial=True
        elif key!='reasoning_tokens':missing.append(label)
    if missing:
        # Listing four field names is noise when the client reported none of them.
        shown=[label for key,label in DISPLAY_FIELDS if key in entry['fields']]
        parts.append('无 token 明细' if not shown else '未提供：'+'、'.join(missing))
    parts.append(settle_text(entry))
    line=' · '.join(parts)
    # One note instead of repeating it on every figure.
    if partial:line+=' · 部分调用未返回这些数字'
    return line


def pool_line(pool,entry):
    return f'{pool} · '+compact_line(entry)


def total_line(pools):
    calls=sum(entry['calls'] for entry in pools.values())
    settled={pool:sum(entry['credits'].values()) for pool,entry in pools.items()}
    reported=[pool for pool,amount in settled.items() if amount]
    parts=[f'合计 {calls} 次调用']
    if reported:parts.append('扣减积分 '+' + '.join(f'{figure(settled[pool])}（{pool}）' for pool in reported))
    missing=len(pools)-len(reported)
    if reported and missing:parts.append(f'{missing} 个平台未提供积分')
    elif missing==len(pools):parts.append('积分未提供')
    return ' · '.join(parts)


def cache_line(pools):
    """What the cache figures do and do not say, using only reported numbers."""
    said=[];silent=[]
    for pool,entry in pools.items():
        fields=entry['fields'];read=fields.get('cache_read_tokens');write=fields.get('cache_write_tokens')
        if read is None and write is None:silent.append(pool);continue
        detail=[]
        if read is not None:
            share=''
            if fields.get('input_tokens'):share=f'占该平台输入 {read/fields["input_tokens"]:.0%}'
            detail.append(f'缓存读取 {figure(read)}'+(f'（{share}）' if share else ''))
        if write is not None:detail.append(f'缓存写入 {figure(write)}')
        elif read is not None:detail.append('缓存写入 未提供')
        said.append(pool+' '+' · '.join(detail))
    parts=[text for text in said]
    if not said and silent:return '缓存：客户端未返回'
    if not said and not silent:return ''
    return '缓存：'+'；'.join(parts)


def cache_hint():
    return '缓存读取＝命中缓存、未按全量重算的输入 token；缓存写入＝本轮写入缓存的 token；未提供表示客户端没有返回，不做估算。提示词字符数只用于排查重复传输，不折算额度。'


def usage_report(store,node_id=None):
    """Lines for one run: pool rows, a total only across pools, then the cache reading."""
    pools=usage_pools(store,node_id=node_id)
    if not pools:return []
    lines=[pool_line(pool,entry) for pool,entry in pools.items()]
    if len(pools)>1:lines.append(total_line(pools))
    lines.append(cache_line(pools))
    return [line for line in lines if line]


def node_usage_line(store,node_id):
    """One short line for a member card, or empty when the client reported nothing."""
    pools=usage_pools(store,node_id=node_id)
    if not pools:return ''
    parts=[]
    for pool,entry in pools.items():
        fields=entry['fields'];bits=[f'{entry["calls"]} 次']
        for key,label in [('input_tokens','输入'),('output_tokens','输出'),('cache_read_tokens','缓存读')]:
            if fields.get(key) is not None:bits.append(f'{label} {figure(fields[key])}')
        bits.append(settle_text(entry))
        parts.append('、'.join(bits) if len(pools)==1 else f'{pool} '+'、'.join(bits))
    return '用量：'+'；'.join(parts)
