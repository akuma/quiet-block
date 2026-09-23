/**
 * The built-in starter list.
 *
 * This is intentionally small and conservative: well-known advertising
 * domains only, nothing that a normal site depends on. It exists so that
 * QuietBlock blocks something useful before the first network fetch of
 * EasyList succeeds, and so that it still works offline. EasyList remains the
 * primary list; this is a floor, not a replacement.
 *
 * Kept as a filter-list string so it flows through exactly the same parser as
 * a downloaded list - there is no second code path to maintain.
 */
export const STARTER_LIST = String.raw`
! QuietBlock starter list - built in, no network required
! Advertising servers and exchanges
||doubleclick.net^
||googleadservices.com^
||googlesyndication.com^
||google-analytics.com^$third-party
||adservice.google.com^
||partner.googleadservices.com^
||pagead2.googlesyndication.com^
||tpc.googlesyndication.com^
||ads.yahoo.com^
||adtechus.com^
||adnxs.com^
||adsrvr.org^
||rubiconproject.com^
||pubmatic.com^
||openx.net^
||criteo.com^
||criteo.net^
||casalemedia.com^
||bidswitch.net^
||smartadserver.com^
||adform.net^
||adcolony.com^
||applovin.com^
||appsflyer.com^
||adjust.com^
||kochava.com^
||unityads.unity3d.com^
||chartboost.com^
||vungle.com^
||inmobi.com^
||startappservice.com^
||moatads.com^
||adsafeprotected.com^
||scorecardresearch.com^
||quantserve.com^
||amazon-adsystem.com^
||aaxads.com^
||media.net^
||gumgum.com^
||sharethrough.com^
||spotxchange.com^
||spotx.tv^
||teads.tv^
||sovrn.com^
||33across.com^
||adroll.com^
||demdex.net^
||everesttech.net^
||krxd.net^
||bluekai.com^
||exelator.com^
||mathtag.com^
||turn.com^
||ads.linkedin.com^
||ads-twitter.com^
||analytics.twitter.com^
||ads.tiktok.com^
||analytics.tiktok.com^

! Content recommendation widgets (the "you may also like" ad blocks)
||taboola.com^
||outbrain.com^
||revcontent.com^
||zergnet.com^
||mgid.com^

! Popunder and low-quality ad networks
||popads.net^
||popcash.net^
||onclickads.net^
||adsterra.com^
||propellerads.com^
||adcash.com^
||exoclick.com^

! Common Chinese advertising and analytics endpoints
||cbjs.baidu.com^
||pos.baidu.com^
||hm.baidu.com^
||union.baidu.com^
||cnzz.com^
||umeng.com^
||umeng.co^
||e.qq.com^
||beacon.qq.com^
||p.l.qq.com^
||tad.qq.com^

! Generic ad paths that are safe to block everywhere
||google.com/pagead^
||googlesyndication.com/pagead^
`;
