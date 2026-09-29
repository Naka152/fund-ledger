"""常用指数目录（供“链接指数”快速选择）。

罗素、MSCI 等指数没有免费的实时指数行情，用跟踪它们的 iShares 等 ETF 代理，
ETF 盘中涨跌与指数几乎一致，而且有完整的日 K 可用于校准。
"""

# (id, 名称, 分组, 备注/别名)
ITEMS = [
    ('1.000510', '中证A500', 'A股', 'a500 中证a500'),
    ('1.000300', '沪深300', 'A股', 'hs300 csi300'),
    ('1.000905', '中证500', 'A股', 'zz500 csi500'),
    ('1.000852', '中证1000', 'A股', 'zz1000'),
    ('2.932000', '中证2000', 'A股', 'zz2000'),
    ('1.000016', '上证50', 'A股', 'sz50'),
    ('1.000688', '科创50', 'A股', 'kc50 科创板'),
    ('0.399006', '创业板指', 'A股', 'cyb 创业板'),
    ('1.000001', '上证指数', 'A股', 'szzs 上证综指'),
    ('0.399001', '深证成指', 'A股', 'szcz'),
    ('1.000922', '中证红利', 'A股', 'zzhl 红利'),
    ('0.899050', '北证50', 'A股', 'bz50 北交所'),
    ('100.HSI', '恒生指数', '港股', 'hsi hang seng'),
    ('124.HSTECH', '恒生科技指数', '港股', 'hstech 恒生科技 hang seng tech'),
    ('100.HSCEI', '恒生中国企业指数', '港股', 'hscei 国企指数 h股'),
    ('124.HSHCI', '恒生医疗保健指数', '港股', 'hshci 港股医疗 恒生医疗'),
    ('124.HSIII', '恒生互联网科技业指数', '港股', 'hsiii 恒生互联网'),
    ('124.HSCI', '恒生综合指数', '港股', 'hsci'),
    ('2.931573', '中证港股通科技', '港股', '港股通科技'),
    ('2.H11136', '中证海外中国互联网', '中概', 'h11136 中概互联 中国互联网'),
    ('2.930604', '中证海外中国互联网30', '中概', '930604 中概互联网30'),
    ('107.KWEB', '中国海外互联网 ETF (KWEB)', '中概', 'kweb 中概互联'),
    ('100.NDX100', '纳斯达克100', '美股', 'ndx nasdaq100 纳指100'),
    ('100.NDX', '纳斯达克综合指数', '美股', 'ixic nasdaq composite 纳指'),
    ('100.SPX', '标普500', '美股', 'spx s&p500 sp500 标准普尔'),
    ('100.DJIA', '道琼斯工业平均', '美股', 'dji dow 道指'),
    ('251.SOX', '费城半导体指数', '美股', 'sox phlx 半导体'),
    ('107.RSP', '标普500等权 (RSP)', '美股', 'rsp equal weight'),
    ('107.IWF', '罗素1000成长 · IWF', '罗素', 'russell 1000 growth rlg 罗素成长'),
    ('yf:^RLG', '罗素1000成长指数 ^RLG（仅实时）', '罗素', 'russell 1000 growth index rlg 罗素成长'),
    ('107.IWD', '罗素1000价值 · IWD', '罗素', 'russell 1000 value 罗素价值'),
    ('107.IWB', '罗素1000 · IWB', '罗素', 'russell 1000'),
    ('107.IWM', '罗素2000 · IWM', '罗素', 'russell 2000 rut 小盘'),
    ('yf:^RUT', '罗素2000指数 ^RUT', '罗素', 'russell 2000 index rut'),
    ('107.IWO', '罗素2000成长 · IWO', '罗素', 'russell 2000 growth 罗素成长'),
    ('107.IWN', '罗素2000价值 · IWN', '罗素', 'russell 2000 value 罗素价值'),
    ('107.IWP', '罗素中盘成长 · IWP', '罗素', 'russell midcap growth 罗素成长'),
    ('107.IWR', '罗素中盘 · IWR', '罗素', 'russell midcap'),
    ('107.URTH', 'MSCI 全球 (World) · URTH', 'MSCI', 'msci world 全球发达'),
    ('105.ACWI', 'MSCI 全球 (ACWI) · ACWI', 'MSCI', 'msci acwi all country'),
    ('107.EEM', 'MSCI 新兴市场 · EEM', 'MSCI', 'msci emerging markets em'),
    ('107.EFA', 'MSCI 欧澳远东 (EAFE) · EFA', 'MSCI', 'msci eafe 发达市场'),
    ('107.EUSA', 'MSCI 美国等权 · EUSA', 'MSCI', 'msci usa equal weighted'),
    ('107.QUAL', 'MSCI 美国质量因子 · QUAL', 'MSCI', 'msci usa quality factor 品质'),
    ('107.MTUM', 'MSCI 美国动量因子 · MTUM', 'MSCI', 'msci usa momentum'),
    ('107.USMV', 'MSCI 美国最小波动 · USMV', 'MSCI', 'msci usa min vol 低波'),
    ('105.MCHI', 'MSCI 中国 · MCHI', 'MSCI', 'msci china'),
    ('2.716567', 'MSCI 中国A股国际通', 'MSCI', 'msci china a inclusion 716567'),
    ('107.EWJ', 'MSCI 日本 · EWJ', 'MSCI', 'msci japan 东证 topix'),
    ('107.INDA', 'MSCI 印度 · INDA', 'MSCI', 'msci india'),
    ('107.EWY', 'MSCI 韩国 · EWY', 'MSCI', 'msci korea'),
    ('107.EWT', 'MSCI 台湾 · EWT', 'MSCI', 'msci taiwan'),
    ('107.EWG', 'MSCI 德国 · EWG', 'MSCI', 'msci germany'),
    ('107.EWZ', 'MSCI 巴西 · EWZ', 'MSCI', 'msci brazil'),
    ('107.KSA', 'MSCI 沙特 · KSA', 'MSCI', 'msci saudi 沙特 富时沙特'),
    ('107.XLK', '标普信息科技 · XLK', '行业', 'technology select 信息科技'),
    ('105.QTEC', '纳斯达克100科技 · QTEC', '行业', 'nasdaq 100 technology 纳斯达克科技'),
    ('107.XBI', '标普生物科技 · XBI', '行业', 'biotech 生物科技'),
    ('105.IBB', '纳斯达克生物科技 · IBB', '行业', 'nasdaq biotechnology nbi 生物科技'),
    ('107.XOP', '标普油气开采 · XOP', '行业', 'oil gas exploration 石油 油气'),
    ('107.IEO', '道琼斯美国油气开采 · IEO', '行业', 'oil gas 石油 油气 道琼斯石油'),
    ('107.IXJ', '标普全球医疗 · IXJ', '行业', 'global healthcare 全球医疗'),
    ('100.N225', '日经225', '全球', 'n225 nikkei 日本'),
    ('100.KS11', '韩国综合 KOSPI', '全球', 'kospi 韩国'),
    ('100.TWII', '台湾加权', '全球', 'twii 台湾'),
    ('100.SENSEX', '印度孟买 SENSEX', '全球', 'sensex 印度'),
    ('100.VNINDEX', '越南胡志明指数', '全球', 'vn 越南'),
    ('100.AS51', '澳大利亚标普200', '全球', 'asx 澳洲'),
    ('100.GDAXI', '德国DAX', '全球', 'dax 德国'),
    ('100.FCHI', '法国CAC40', '全球', 'cac 法国'),
    ('100.SX5E', '欧洲斯托克50', '全球', 'stoxx 欧洲'),
    ('100.FTSE', '英国富时100', '全球', 'ftse 英国'),
    ('100.BVSP', '巴西 BOVESPA', '全球', 'ibovespa 巴西'),
    ('118.AU9999', '上海金 Au99.99', '商品', 'gold 黄金'),
    ('101.GC00Y', 'COMEX 黄金', '商品', 'gold 黄金'),
    ('102.CL00Y', 'NYMEX 原油', '商品', 'crude oil wti 原油'),
    ('120.USDCNYC', '美元兑人民币中间价', '汇率', 'usd cny 美元 汇率'),
]

FEATURED = ['1.000510', '1.000300', '124.HSTECH', '100.HSI', '100.NDX100', '100.SPX',
            '107.IWF', '107.URTH', '107.EEM', '251.SOX', '100.N225', '118.AU9999']

DEFAULT_WATCH = ['1.000510', '1.000300', '124.HSTECH', '100.HSI', '100.NDX100', '100.SPX']

_BY_ID = {i[0]: i for i in ITEMS}


def _row(it):
    iid, name, group, _ = it
    is_etf = '·' in name or name.endswith(')')
    return {'id': iid, 'code': iid.split('.', 1)[-1].replace('yf:', ''), 'name': name,
            'type': 'ETF' if is_etf else '指数', 'group': group}


def name_of(iid):
    it = _BY_ID.get(iid)
    return it[1] if it else None


def featured():
    return [_row(_BY_ID[i]) for i in FEATURED]


def all_items():
    return [_row(it) for it in ITEMS]


def match(q):
    low = q.lower().replace(' ', '')
    out = []
    for it in ITEMS:
        hay = (it[0] + it[1] + it[2] + it[3]).lower().replace(' ', '')
        if low in hay:
            out.append(_row(it))
    return out
