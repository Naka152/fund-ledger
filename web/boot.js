// 在首屏渲染前应用主题与涨跌颜色，避免闪烁
(function () {
  try {
    var t = localStorage.getItem('fl.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    if (localStorage.getItem('fl.up') === 'green') document.documentElement.setAttribute('data-up', 'green');
  } catch (e) { /* 忽略 */ }
})();
