/* 旅搭 TripMate · 纯前端规则引擎
 *
 * 本文件是 tripmate/ 包（data / slots / planner / validator / orchestrator / export）
 * 的浏览器端等价实现：同一套 POI 白名单、同一组 R1–R7 规则、同一套重排动作，
 * 输出结构与 Python 版 RunResult.to_dict() 对齐，因此静态托管也能完整演示闭环。
 */
(function (root) {
  "use strict";

  // -------------------------------------------------------------------------
  // 基础工具
  // -------------------------------------------------------------------------

  const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

  const POI = "poi";
  const MEAL = "meal";
  const TRANSPORT = "transport";
  const INTERCITY = "intercity";
  const FREE = "free";
  const ACTIVE_TYPES = [POI, TRANSPORT];

  const EARTH_RADIUS_KM = 6371.0;
  const ROAD_FACTOR = 1.3;

  function clockToMin(value) {
    const parts = String(value).split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function minToClock(value) {
    const v = Math.max(0, Math.trunc(value)) % 1440;
    return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
  }

  function pyRound(value) {
    return Math.round(value); // 本项目的数值不会落在 .5 的银行家舍入边界上
  }

  function dateToISO(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function addDays(base, n) {
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  }

  function weekdayOf(dateStr) {
    const parts = dateStr.split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return WEEKDAYS[(d.getDay() + 6) % 7];
  }

  function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function distanceKm(lat1, lng1, lat2, lng2) {
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = p2 - p1;
    const dl = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  }

  function estimateTransport(km, extraMin) {
    const realKm = km * ROAD_FACTOR;
    const extra = extraMin || 0;
    if (realKm <= 1.2) {
      const minutes = Math.trunc(realKm * 12) + 2;
      return { mode: "步行", line: "", minutes: minutes, walk: Math.trunc(realKm * 1000) };
    }
    if (realKm <= 9) {
      return { mode: "公交", line: "", minutes: Math.trunc((realKm / 16) * 60) + 7 + extra, walk: 350 };
    }
    if (realKm <= 22) {
      return { mode: "地铁", line: "", minutes: Math.trunc((realKm / 24) * 60) + 8 + extra, walk: 400 };
    }
    return { mode: "打车", line: "", minutes: Math.trunc((realKm / 30) * 60) + 5 + extra, walk: 150 };
  }

  function walkBetween(km) {
    return Math.trunc(Math.max(400, Math.min(2000, km * 1000 * 0.6)));
  }

  // -------------------------------------------------------------------------
  // 离线数据（与 tripmate/data.py 保持一致）
  // -------------------------------------------------------------------------

  function poi(id, name, area, lat, lng, tags, cost, duration, priority,
               openStart, openEnd, extra) {
    const item = {
      id: id, name: name, area: area, lat: lat, lng: lng, tags: tags,
      cost: cost, duration_min: duration, priority: priority,
      open_start: openStart, open_end: openEnd,
      indoor: false, closed: "", extra_min: 0, note: ""
    };
    Object.assign(item, extra || {});
    return item;
  }

  const XIAMEN = {
    key: "xiamen",
    name: "厦门",
    hotel_name: "思明区青旅（中山路附近）",
    hotel_lat: 24.4450,
    hotel_lng: 118.0880,
    intercity_name: "广州 → 厦门 动车",
    intercity_min: 250,
    intercity_cost: 200,
    home: "广州",
    pois: [
      poi("gulangyu", "鼓浪屿", "鼓浪屿", 24.4471, 118.0689, ["海", "拍照", "人文"], 35, 210, 5, "08:00", "18:00",
        { extra_min: 25, note: "船票需提前 1 天购买，末班船 21:00" }),
      poi("riguangyan", "日光岩", "鼓浪屿", 24.4476, 118.0670, ["自然", "拍照"], 50, 90, 4, "07:30", "18:00",
        { extra_min: 25 }),
      poi("xmu", "厦门大学", "思明南", 24.4369, 118.0963, ["人文", "拍照"], 0, 90, 5, "08:00", "17:00",
        { note: "需提前预约进校" }),
      poi("nanputuo", "南普陀寺", "思明南", 24.4398, 118.0990, ["人文"], 0, 90, 5, "04:00", "17:00"),
      poi("shapowei", "沙坡尾", "思明南", 24.4448, 118.0894, ["拍照", "小吃"], 0, 90, 4, "10:00", "22:00"),
      poi("maojie", "顶澳仔猫街", "思明南", 24.4430, 118.0870, ["拍照", "小吃"], 0, 60, 3, "10:00", "21:00"),
      poi("zengcuoan", "曾厝垵", "环岛", 24.4245, 118.1160, ["小吃", "拍照"], 0, 120, 4, "10:00", "23:00"),
      poi("huandaolu", "环岛路骑行", "环岛", 24.4300, 118.1300, ["海", "自然"], 0, 120, 4, "00:00", "24:00"),
      poi("hulishan", "胡里山炮台", "环岛", 24.4290, 118.1175, ["人文", "海"], 23, 90, 3, "08:00", "17:30"),
      poi("zhongshanlu", "中山路骑楼", "老城", 24.4560, 118.0820, ["小吃", "夜景"], 0, 120, 4, "00:00", "24:00"),
      poi("bashi", "八市", "老城", 24.4600, 118.0800, ["小吃"], 0, 60, 3, "06:00", "20:00"),
      poi("kejiguan", "厦门科技馆", "湖里", 24.4890, 118.1780, ["博物馆"], 25, 180, 3, "09:00", "17:00",
        { indoor: true, closed: "周一" }),
      poi("jimei", "集美学村", "集美", 24.5750, 118.1000, ["人文", "拍照"], 0, 150, 3, "08:00", "18:00",
        { extra_min: 20 }),
      poi("bailuzhou", "白鹭洲公园", "老城", 24.4800, 118.0900, ["夜景", "自然"], 0, 60, 2, "00:00", "24:00"),
      poi("hqmuseum", "华侨博物院", "思明南", 24.4400, 118.0900, ["博物馆", "人文"], 0, 90, 3, "09:00", "17:00",
        { indoor: true, closed: "周一" })
    ]
  };

  const CHANGSHA = {
    key: "changsha",
    name: "长沙",
    hotel_name: "五一广场青旅（地铁 1 号线附近）",
    hotel_lat: 28.1945,
    hotel_lng: 112.9760,
    intercity_name: "广州 → 长沙 高铁",
    intercity_min: 165,
    intercity_cost: 314,
    home: "广州",
    pois: [
      poi("juzizhou", "橘子洲", "岳麓", 28.1840, 112.9610, ["夜景", "自然", "拍照"], 0, 120, 5, "00:00", "24:00",
        { note: "地铁 2 号线直达，烟花日人流大" }),
      poi("yuelushan", "岳麓山", "岳麓", 28.1860, 112.9360, ["自然", "拍照"], 0, 150, 5, "06:00", "23:00"),
      poi("yuelushuyuan", "岳麓书院", "岳麓", 28.1878, 112.9375, ["人文", "拍照"], 40, 90, 4, "08:00", "17:30"),
      poi("hunanmuseum", "湖南博物院", "开福", 28.2140, 112.9940, ["博物馆", "人文"], 0, 180, 5, "09:00", "17:00",
        { indoor: true, closed: "周一", note: "需提前 3 天预约" }),
      poi("taiping", "太平老街", "五一", 28.1950, 112.9690, ["小吃", "夜景", "拍照"], 0, 90, 4, "10:00", "23:30"),
      poi("pozijie", "坡子街", "五一", 28.1905, 112.9735, ["小吃"], 0, 60, 3, "10:00", "23:30"),
      poi("wuyi", "五一广场", "五一", 28.1945, 112.9760, ["夜景", "拍照"], 0, 90, 3, "00:00", "24:00"),
      poi("wenheyou", "超级文和友", "五一", 28.1900, 112.9800, ["小吃", "拍照"], 0, 90, 3, "11:00", "23:30",
        { note: "饭点排号 2 小时起" }),
      poi("tianxinge", "天心阁", "城南", 28.1835, 112.9820, ["人文", "拍照"], 32, 60, 3, "08:00", "17:30"),
      poi("kaifusi", "开福寺", "开福", 28.2135, 112.9760, ["人文"], 10, 60, 2, "07:00", "17:30"),
      poi("xiezi", "谢子龙影像艺术馆", "梅溪湖", 28.1915, 112.8590, ["拍照", "博物馆"], 0, 120, 4, "09:30", "17:30",
        { indoor: true, closed: "周一" }),
      poi("meixihu", "梅溪湖艺术中心", "梅溪湖", 28.1835, 112.8880, ["拍照", "人文"], 0, 90, 3, "00:00", "24:00"),
      poi("wenjing", "长沙世界之窗", "城东", 28.2280, 113.0700, ["拍照", "自然"], 200, 240, 2, "09:00", "22:00"),
      poi("xiangjiang", "湘江夜游", "湘江", 28.1870, 112.9660, ["夜景", "拍照"], 120, 90, 3, "18:00", "22:00",
        { extra_min: 10 })
    ]
  };

  const GUANGZHOU = {
    key: "guangzhou",
    name: "广州",
    hotel_name: "越秀区青旅（北京路附近）",
    hotel_lat: 23.1250,
    hotel_lng: 113.2650,
    intercity_name: "市内出发（无需跨城）",
    intercity_min: 0,
    intercity_cost: 0,
    home: "广州",
    local: true,
    pois: [
      poi("cantontower", "广州塔", "海珠", 23.1066, 113.3245, ["夜景", "拍照", "人文"], 150, 90, 5, "09:30", "22:30",
        { note: "观景层需预约，日落前上塔" }),
      poi("shamian", "沙面岛", "荔湾", 23.1075, 113.2390, ["人文", "拍照"], 0, 90, 4, "00:00", "24:00"),
      poi("chenjiaci", "陈家祠", "荔湾", 23.1290, 113.2460, ["人文", "拍照"], 10, 75, 4, "09:00", "17:30"),
      poi("beijinglu", "北京路步行街", "越秀", 23.1250, 113.2670, ["小吃", "夜景"], 0, 90, 4, "00:00", "24:00"),
      poi("yuexiupark", "越秀公园", "越秀", 23.1400, 113.2660, ["自然", "人文"], 0, 120, 4, "06:00", "21:00"),
      poi("nanyuewang", "南越王博物院", "越秀", 23.1405, 113.2600, ["博物馆", "人文"], 0, 120, 4, "09:00", "17:30",
        { indoor: true, closed: "周一" }),
      poi("shangxiajiu", "上下九步行街", "荔湾", 23.1160, 113.2440, ["小吃", "拍照"], 0, 90, 3, "10:00", "22:00"),
      poi("yongqingfang", "永庆坊", "荔湾", 23.1150, 113.2420, ["拍照", "人文"], 0, 90, 4, "00:00", "24:00"),
      poi("zhujiangcruise", "珠江夜游", "海珠", 23.1080, 113.2650, ["夜景", "拍照"], 120, 90, 4, "18:00", "22:00",
        { extra_min: 10 }),
      poi("baiyunshan", "白云山", "白云", 23.1830, 113.3000, ["自然", "拍照"], 5, 180, 4, "06:00", "21:00",
        { extra_min: 20 }),
      poi("gdmuseum", "广东省博物馆", "天河", 23.1180, 113.3220, ["博物馆", "人文"], 0, 150, 5, "09:00", "17:00",
        { indoor: true, closed: "周一", note: "需提前预约" }),
      poi("huacheng", "花城广场", "天河", 23.1170, 113.3230, ["夜景", "拍照"], 0, 90, 4, "00:00", "24:00"),
      poi("chimelong", "长隆野生动物世界", "番禺", 23.0050, 113.3290, ["自然", "拍照"], 300, 300, 5, "09:30", "18:00",
        { extra_min: 30 }),
      poi("whampoa", "黄埔军校旧址", "黄埔", 23.0890, 113.4160, ["人文"], 0, 120, 3, "09:00", "17:00",
        { closed: "周一", extra_min: 25 }),
      poi("sysu", "中山大学（广州南校园）", "海珠", 23.0965, 113.2985, ["人文", "拍照"], 0, 90, 4, "09:00", "17:00",
        { extra_min: 10, note: "进校需提前在官方渠道预约" }),
      poi("scut", "华南理工大学（五山校区）", "天河", 23.1535, 113.3470, ["人文", "拍照"], 0, 90, 3, "09:00", "17:00",
        { extra_min: 15 })
    ]
  };

  const SHENZHEN = {
    key: "shenzhen",
    name: "深圳",
    hotel_name: "福田区青旅（会展中心附近）",
    hotel_lat: 22.5410,
    hotel_lng: 114.0560,
    intercity_name: "广州 → 深圳 高铁",
    intercity_min: 35,
    intercity_cost: 75,
    home: "广州",
    pois: [
      poi("szbay", "深圳湾公园", "南山", 22.5200, 113.9500, ["海", "自然"], 0, 120, 4, "00:00", "24:00"),
      poi("windowworld", "世界之窗", "南山", 22.5360, 113.9730, ["拍照", "人文"], 220, 240, 4, "09:00", "22:00"),
      poi("happyvalley", "欢乐谷", "南山", 22.5400, 113.9800, ["拍照", "自然"], 230, 300, 4, "09:30", "22:00"),
      poi("lianhuashan", "莲花山公园", "福田", 22.5560, 114.0570, ["自然", "拍照"], 0, 90, 4, "06:00", "23:00"),
      poi("szmuseum", "深圳博物馆", "福田", 22.5480, 114.0570, ["博物馆", "人文"], 0, 120, 4, "10:00", "18:00",
        { indoor: true, closed: "周一" }),
      poi("pingan", "平安金融中心云际观光", "福田", 22.5360, 114.0500, ["夜景", "拍照"], 180, 90, 4, "10:00", "22:00"),
      poi("dongmen", "东门老街", "罗湖", 22.5480, 114.1170, ["小吃", "拍照"], 0, 90, 3, "10:00", "22:00"),
      poi("dameisha", "大梅沙海滨公园", "盐田", 22.5960, 114.3060, ["海", "自然"], 0, 150, 3, "00:00", "24:00",
        { extra_min: 40 }),
      poi("octloft", "华侨城创意文化园", "南山", 22.5410, 113.9940, ["拍照", "人文"], 0, 90, 3, "00:00", "24:00"),
      poi("nantou", "南头古城", "南山", 22.5320, 113.9240, ["人文", "拍照"], 0, 90, 3, "00:00", "24:00"),
      poi("talentpark", "人才公园", "南山", 22.5160, 113.9440, ["夜景", "拍照"], 0, 90, 3, "00:00", "24:00"),
      poi("xianhu", "仙湖植物园", "罗湖", 22.5750, 114.1750, ["自然", "拍照"], 20, 150, 3, "08:00", "18:00",
        { extra_min: 25 }),
      poi("dapeng", "大鹏所城", "大鹏", 22.5960, 114.4940, ["人文", "海"], 0, 120, 3, "00:00", "24:00",
        { extra_min: 70 }),
      poi("seaworld", "海上世界", "南山", 22.4860, 113.9170, ["夜景", "小吃"], 0, 90, 4, "00:00", "24:00"),
      poi("wutongshan", "梧桐山", "罗湖", 22.5830, 114.2160, ["自然", "拍照"], 0, 240, 4, "06:00", "18:00",
        { extra_min: 25, note: "登顶往返约 4 小时，建议早上出发" })
    ]
  };

  const CHONGQING = {
    key: "chongqing",
    name: "重庆",
    hotel_name: "渝中区青旅（解放碑附近）",
    hotel_lat: 29.5570,
    hotel_lng: 106.5770,
    intercity_name: "广州 → 重庆 飞机",
    intercity_min: 150,
    intercity_cost: 620,
    home: "广州",
    pois: [
      poi("hongyadong", "洪崖洞", "渝中", 29.5620, 106.5790, ["夜景", "拍照"], 0, 90, 5, "00:00", "24:00"),
      poi("jiefangbei", "解放碑", "渝中", 29.5570, 106.5770, ["夜景", "拍照"], 0, 60, 4, "00:00", "24:00"),
      poi("liziba", "李子坝轻轨站", "渝中", 29.5560, 106.5210, ["拍照"], 0, 40, 4, "00:00", "24:00",
        { extra_min: 10 }),
      poi("ciqikou", "磁器口古镇", "沙坪坝", 29.5790, 106.4490, ["小吃", "人文"], 0, 120, 4, "00:00", "24:00",
        { extra_min: 20 }),
      poi("cablecar", "长江索道", "渝中", 29.5550, 106.5860, ["拍照", "夜景"], 20, 30, 4, "07:30", "22:00"),
      poi("nanshan", "南山一棵树观景台", "南岸", 29.5380, 106.5960, ["夜景", "拍照"], 30, 60, 4, "09:00", "22:30",
        { extra_min: 20 }),
      poi("sanxiamuseum", "重庆中国三峡博物馆", "渝中", 29.5590, 106.5520, ["博物馆", "人文"], 0, 120, 4, "09:00", "17:00",
        { indoor: true, closed: "周一" }),
      poi("erchang", "鹅岭二厂", "渝中", 29.5530, 106.5360, ["拍照", "人文"], 0, 90, 3, "00:00", "24:00"),
      poi("guanyinqiao", "观音桥步行街", "江北", 29.5760, 106.5320, ["小吃", "夜景"], 0, 90, 3, "00:00", "24:00"),
      poi("chuanyu", "四川美术学院（黄桷坪）", "九龙坡", 29.4830, 106.5390, ["人文", "拍照"], 0, 90, 3, "09:00", "17:00"),
      poi("chaotianmen", "朝天门广场", "渝中", 29.5640, 106.5880, ["夜景", "拍照"], 0, 60, 4, "00:00", "24:00"),
      poi("wulong", "武隆天生三桥", "武隆", 29.4600, 107.7800, ["自然", "拍照"], 125, 240, 2, "08:00", "16:00",
        { extra_min: 120 }),
      poi("cqzoo", "重庆动物园", "九龙坡", 29.5000, 106.5140, ["自然", "拍照"], 25, 120, 3, "08:00", "17:00"),
      poi("danzishi", "弹子石老街", "南岸", 29.5540, 106.5950, ["人文", "夜景", "拍照"], 0, 90, 3, "00:00", "24:00")
    ]
  };

  const CHENGDU = {
    key: "chengdu",
    name: "成都",
    hotel_name: "锦江区青旅（春熙路附近）",
    hotel_lat: 30.6570,
    hotel_lng: 104.0810,
    intercity_name: "广州 → 成都 飞机",
    intercity_min: 165,
    intercity_cost: 700,
    home: "广州",
    pois: [
      poi("kuanzhai", "宽窄巷子", "青羊", 30.6690, 104.0550, ["人文", "小吃", "拍照"], 0, 90, 5, "00:00", "24:00"),
      poi("jinli", "锦里", "武侯", 30.6460, 104.0470, ["小吃", "夜景"], 0, 120, 5, "00:00", "24:00"),
      poi("wuhouci", "武侯祠", "武侯", 30.6450, 104.0480, ["人文"], 50, 90, 5, "08:00", "18:00"),
      poi("dufucaotang", "杜甫草堂", "青羊", 30.6640, 104.0290, ["人文", "自然"], 50, 120, 4, "08:00", "18:00"),
      poi("peoplespark", "人民公园", "青羊", 30.6590, 104.0550, ["人文", "自然"], 0, 90, 4, "06:00", "22:00"),
      poi("taiguli", "春熙路·太古里", "锦江", 30.6520, 104.0810, ["小吃", "夜景", "拍照"], 0, 120, 4, "00:00", "24:00"),
      poi("pandabase", "大熊猫繁育研究基地", "成华", 30.7330, 104.1460, ["自然", "拍照"], 55, 180, 5, "07:30", "18:00",
        { extra_min: 20 }),
      poi("scmuseum", "四川博物院", "青羊", 30.6650, 104.0230, ["博物馆", "人文"], 0, 120, 4, "09:00", "17:00",
        { indoor: true, closed: "周一" }),
      poi("cdmuseum", "成都博物馆", "青羊", 30.6570, 104.0640, ["博物馆", "人文"], 0, 120, 4, "09:00", "17:00",
        { indoor: true, closed: "周一" }),
      poi("qingyanggong", "青羊宫", "青羊", 30.6630, 104.0380, ["人文"], 10, 60, 3, "08:00", "18:00"),
      poi("dongjiaomemory", "东郊记忆", "成华", 30.6690, 104.1190, ["拍照", "人文"], 0, 90, 3, "00:00", "24:00"),
      poi("jiuyanqiao", "九眼桥", "武侯", 30.6470, 104.0870, ["夜景", "小吃"], 0, 90, 4, "00:00", "24:00"),
      poi("dujiangyan", "都江堰", "都江堰", 31.0000, 103.6200, ["人文", "自然"], 80, 180, 3, "08:00", "18:00",
        { extra_min: 60 }),
      poi("globalcenter", "环球中心", "高新", 30.5720, 104.0640, ["拍照", "小吃"], 0, 90, 3, "00:00", "24:00")
    ]
  };

  const CITIES = { xiamen: XIAMEN, changsha: CHANGSHA, guangzhou: GUANGZHOU, shenzhen: SHENZHEN, chongqing: CHONGQING, chengdu: CHENGDU };

  const GUIDE_TIPS = [
    ["鼓浪屿", "船票与日光岩需提前购票，岛上无机动车，步行量偏大"],
    ["厦门大学", "进校需提前在官方渠道预约，周末名额紧张"],
    ["科技馆", "周一闭馆，节假日除外"],
    ["环岛路", "骑行注意防晒，傍晚海风较凉"],
    ["八市", "上午最热闹，海鲜加工要先问价"],
    ["橘子洲", "烟花日地铁末班车延后，但人流很大，注意错峰"],
    ["湖南博物院", "免费但需提前预约，周一闭馆"],
    ["文和友", "饭点排号很久，建议避开 18:00-19:30"],
    ["岳麓山", "可坐索道上山，步行下山更省体力"],
    ["广州塔", "观景层需提前预约，日落前后排队最久"],
    ["长隆", "园区很大，建议开园就进，全天步行量偏高"],
    ["洪崖洞", "夜间人流极大，拍照可去千厮门大桥对岸"],
    ["大熊猫", "7:30 开园，上午熊猫最活跃，尽量早到"],
    ["都江堰", "离市区约 1 小时车程，返程留足时间"],
    ["梧桐山", "登顶往返约 4 小时，尽量早上出发并带足水"],
    ["中山大学", "进校需提前在官方渠道预约，周末名额紧张"],
    ["华南理工大学", "五山校区可自由参观，校内食堂需刷卡"]
  ];

  const WEATHER_PATTERN = ["多云", "小雨", "晴"];

  function weatherForDay(index) {
    const condition = WEATHER_PATTERN[index % WEATHER_PATTERN.length];
    return { condition: condition, temp: 24 - index, rain: condition.indexOf("雨") >= 0 };
  }

  function tipsFor(p) {
    for (let i = 0; i < GUIDE_TIPS.length; i++) {
      if (p.name.indexOf(GUIDE_TIPS[i][0]) >= 0) return GUIDE_TIPS[i][1];
    }
    return p.note;
  }

  function packingFor(slots, rain) {
    const items = ["身份证", "学生证", "充电宝", "舒适步行鞋"];
    if (rain) items.push("折叠伞", "防水鞋套");
    if (slots.tags && slots.tags.indexOf("海") >= 0) items.push("防晒霜", "墨镜");
    if (slots.tags && slots.tags.indexOf("小吃") >= 0) items.push("肠胃药（吃辣备着）");
    if (slots.days >= 3) items.push("换洗衣物 3 套", "洗漱包");
    items.push("晕车药");
    return items;
  }

  function rolesFor(people) {
    const tasks = [
      ["订房与退改", "住宿确认、比价"],
      ["买票与预约", "门票、船票、博物馆预约"],
      ["记账与点菜", "每日记账、找本地小吃"],
      ["行程与导航", "当天路线、公交查询"],
      ["拍照与备份", "照片存档、行程截图"],
      ["应急联络", "天气变化、改签"]
    ];
    const owners = ["A", "B", "C"];
    const result = [];
    const limit = Math.max(3, people * 2);
    for (let i = 0; i < tasks.length && i < limit; i++) {
      result.push({ task: tasks[i][0], detail: tasks[i][1], owner: owners[i % 3] });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 槽位抽取（tripmate/slots.py）
  // -------------------------------------------------------------------------

  const CN_NUM = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7 };

  const TAG_WORDS = {
    "海": ["海", "海边", "看海", "沙滩"],
    "小吃": ["小吃", "吃", "美食", "海鲜", "夜市"],
    "拍照": ["拍照", "出片", "机位", "打卡"],
    "人文": ["人文", "历史", "寺庙", "大学", "建筑"],
    "自然": ["自然", "爬山", "公园", "骑行"],
    "博物馆": ["博物馆", "科技馆", "展"],
    "夜景": ["夜景", "晚上逛"]
  };

  const PACE_LAZY = ["不爱早起", "轻松", "摆烂", "慢节奏", "带老人", "带小孩"];
  const PACE_HARD = ["特种兵", "紧凑", "拉满", "暴走"];

  const DEFAULTS = {
    days: 3, people: 2, budget: 800, tags: ["海", "小吃"], pace: "标准", city: "xiamen"
  };

  function toNum(token) {
    if (/^\d+$/.test(token)) return parseInt(token, 10);
    return CN_NUM[token] || null;
  }

  function extract(text, today) {
    const base = today || new Date();
    const slots = { raw: text, start: dateToISO(addDays(base, 7)) };

    const lower = text.toLowerCase();
    for (const key in CITIES) {
      if (text.indexOf(CITIES[key].name) >= 0 || lower.indexOf(key) >= 0) {
        slots.city = key;
        break;
      }
    }

    let m = text.match(/(\d+|一|两|二|三|四|五|六|七)\s*(天|日)/);
    if (m && toNum(m[1])) slots.days = toNum(m[1]);

    m = text.match(/(\d+|一|两|二|三|四|五|六)\s*(人|个人)/);
    if (m && toNum(m[1])) slots.people = toNum(m[1]);

    const budgetPatterns = [/(?:人均)\s*(\d+)/, /(?:预算)\s*(\d+)/, /(?:每人)\s*(\d+)/];
    for (let i = 0; i < budgetPatterns.length; i++) {
      m = text.match(budgetPatterns[i]);
      if (m) { slots.budget = parseInt(m[1], 10); break; }
    }
    if (!("budget" in slots)) {
      m = text.match(/(\d+)\s*元/);
      if (m) slots.budget = parseInt(m[1], 10);
    }

    const tags = Object.keys(TAG_WORDS).filter((tag) =>
      TAG_WORDS[tag].some((w) => text.indexOf(w) >= 0)
    );
    if (tags.length) slots.tags = tags;

    if (PACE_LAZY.some((w) => text.indexOf(w) >= 0)) slots.pace = "轻松";
    else if (PACE_HARD.some((w) => text.indexOf(w) >= 0)) slots.pace = "紧凑";

    return slots;
  }

  function fillDefaults(slots) {
    const filled = Object.assign({}, slots);
    for (const key in DEFAULTS) {
      if (!(key in filled)) filled[key] = DEFAULTS[key];
    }
    filled.tags = (filled.tags && filled.tags.length) ? filled.tags.slice() : DEFAULTS.tags.slice();
    return filled;
  }

  function missingSlots(slots) {
    const labels = { city: "目的地", days: "天数", people: "人数", budget: "人均预算" };
    return Object.keys(labels).filter((key) => !(key in slots)).map((key) => labels[key]);
  }

  // -------------------------------------------------------------------------
  // 行程生成（tripmate/planner.py）
  // -------------------------------------------------------------------------

  const PACE_POI = { "轻松": 2, "标准": 3, "紧凑": 4 };
  const PACE_WALK = { "轻松": 8, "标准": 12, "紧凑": 16 };
  const PACE_START = { "轻松": 10 * 60, "标准": 9 * 60, "紧凑": 8 * 60 + 30 };

  const LUNCH_COST = 25;
  const DINNER_COST = 35;
  const STAY_PER_NIGHT = 80;
  const LOCAL_FARE = 2;
  const DEPART_START = 15 * 60 + 30;

  function score(p, tags) {
    let hits = 0;
    tags.forEach((tag) => { if (p.tags.indexOf(tag) >= 0) hits += 1; });
    return hits * 2 + p.priority;
  }

  function byName(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function poiMap(city) {
    const map = {};
    city.pois.forEach((p) => { map[p.id] = p; });
    return map;
  }

  function makeDraft(slots, city) {
    const tags = slots.tags || [];
    const schedulable = city.pois.filter((p) => clockToMin(p.open_start) <= 16 * 60);
    const ranked = schedulable.slice().sort((a, b) =>
      (score(b, tags) - score(a, tags)) || (b.priority - a.priority) || byName(a.name, b.name)
    );

    const days = slots.days;
    const perDay = PACE_POI[slots.pace || "标准"] || 3;
    const counts = [];
    for (let i = 0; i < days; i++) {
      counts.push(i === days - 1 && days > 1 ? 1 : Math.min(perDay, 3));
    }

    const startParts = slots.start.split("-").map(Number);
    const start = new Date(startParts[0], startParts[1] - 1, startParts[2]);

    let cursor = 0;
    const picked = [];
    const dayPlans = [];
    for (let i = 0; i < counts.length; i++) {
      const ids = ranked.slice(cursor, cursor + counts[i]).map((p) => p.id);
      cursor += counts[i];
      picked.push.apply(picked, ids);
      dayPlans.push({
        index: i,
        date: dateToISO(addDays(start, i)),
        poi_ids: ids
      });
    }
    return { days: dayPlans, picked: picked };
  }

  function addItem(items, dayIndex, start, minutes, kind, name, cost, walkM, mode, indoor) {
    const end = start + Math.max(1, minutes);
    items.push({
      id: "d" + (dayIndex + 1) + "_" + (items.length + 1),
      start: minToClock(start),
      end: minToClock(end),
      type: kind,
      name: name,
      minutes: Math.max(1, minutes),
      cost: cost || 0,
      walk_m: walkM || 0,
      mode: mode || "",
      line: "",
      indoor: indoor || false
    });
    return end;
  }

  function buildDay(dayPlan, city, slots, isFirst, isLast) {
    const index = dayPlan.index;
    const dateStr = dayPlan.date;
    const weekday = weekdayOf(dateStr);
    const weather = weatherForDay(index);
    const pois = poiMap(city);

    const items = [];
    const depart = slots.days === 1 ? 20 * 60 : DEPART_START;
    const cutoff = depart - 90;
    let cursor;
    if (isFirst && !city.local) {
      cursor = addItem(items, index, 7 * 60, city.intercity_min, INTERCITY,
        city.intercity_name, city.intercity_cost);
      cursor = Math.max(cursor + 20, 9 * 60);
    } else {
      cursor = PACE_START[slots.pace || "标准"] || 9 * 60;
    }

    let prev = [city.hotel_lat, city.hotel_lng];
    let lunchDone = false;

    for (let i = 0; i < dayPlan.poi_ids.length; i++) {
      const pid = dayPlan.poi_ids[i];
      const p = pois[pid];
      if (!p) continue;
      const openMin = clockToMin(p.open_start);
      if (openMin - cursor > 150) continue;
      if (isLast && !city.local && Math.max(cursor, openMin) + p.duration_min > cutoff) break;

      if (!lunchDone && cursor >= 11 * 60) {
        cursor = addItem(items, index, cursor, 60, MEAL, "午餐（本地小吃）", LUNCH_COST);
        lunchDone = true;
      }

      const km = distanceKm(prev[0], prev[1], p.lat, p.lng);
      const tr = estimateTransport(km, p.extra_min);
      cursor = addItem(items, index, cursor, tr.minutes, TRANSPORT,
        tr.mode + "前往" + p.name, tr.mode === "步行" ? 0 : LOCAL_FARE,
        tr.walk, tr.mode);

      if (cursor < openMin) {
        cursor = addItem(items, index, cursor, openMin - cursor, FREE, "等待开门");
      }

      cursor = addItem(items, index, cursor, p.duration_min, POI, p.name,
        p.cost, walkBetween(km), "", p.indoor);
      prev = [p.lat, p.lng];
    }

    if (isLast && !city.local) {
      if (!lunchDone && depart - cursor > 150) {
        if (cursor < 11 * 60) {
          cursor = addItem(items, index, cursor, 11 * 60 - cursor, FREE, "自由活动（附近闲逛）");
        }
        cursor = addItem(items, index, cursor, 60, MEAL, "午餐（本地小吃）", LUNCH_COST);
        lunchDone = true;
      }
      const gap = depart - cursor;
      if (gap > 90) {
        cursor = addItem(items, index, cursor, gap - 30, FREE, "自由活动（伴手礼 / 附近闲逛）");
        cursor = addItem(items, index, cursor, 30, FREE, "候车与返程准备");
      } else if (gap > 0) {
        cursor = addItem(items, index, cursor, gap, FREE, "候车与返程准备");
      }
      const label = city.intercity_name.split(" ").slice(-1)[0];
      cursor = addItem(items, index, depart, city.intercity_min, INTERCITY,
        city.name + " → " + city.home + " 返程" + label, city.intercity_cost);
    } else {
      if (!lunchDone && cursor >= 11 * 60 && cursor < 18 * 60) {
        cursor = addItem(items, index, cursor, 60, MEAL, "午餐（本地小吃）", LUNCH_COST);
      }
      if (cursor < 18 * 60) {
        cursor = addItem(items, index, cursor, 18 * 60 - cursor, FREE, "回住处休整");
      }
      cursor = addItem(items, index, cursor, 60, MEAL, "晚餐", DINNER_COST);
      const km = distanceKm(prev[0], prev[1], city.hotel_lat, city.hotel_lng);
      const tr = estimateTransport(km);
      addItem(items, index, cursor, tr.minutes, TRANSPORT,
        tr.mode + "返回住处", tr.mode === "步行" ? 0 : LOCAL_FARE,
        tr.walk, tr.mode, true);
    }

    const walkTotal = items.reduce((n, item) => n + item.walk_m, 0);
    const backup = pickBackup(city, weekday, prev, new Set(dayPlan.poi_ids));
    return {
      index: index, date: dateStr, weekday: weekday,
      weather: weather.condition, items: items,
      backup_indoor: backup, walk_total_m: walkTotal
    };
  }

  function pickBackup(city, weekday, ref, used) {
    const candidates = city.pois.filter((p) => p.indoor && p.closed !== weekday);
    if (!candidates.length) return "";
    candidates.sort((a, b) => distanceKm(ref[0], ref[1], a.lat, a.lng) - distanceKm(ref[0], ref[1], b.lat, b.lng));
    for (let i = 0; i < candidates.length; i++) {
      if (!used.has(candidates[i].id)) return candidates[i].name;
    }
    return candidates[0].name;
  }

  function poiIdByName(city, name) {
    for (let i = 0; i < city.pois.length; i++) {
      if (city.pois[i].name === name) return city.pois[i].id;
    }
    return "";
  }

  function assemble(slots, draft, city) {
    const days = draft.days.map((dp, i) =>
      buildDay(dp, city, slots, i === 0, i === draft.days.length - 1)
    );

    let tickets = 0;
    let local = 0;
    let food = 0;
    let intercity = 0;
    days.forEach((d) => {
      d.items.forEach((item) => {
        if (item.type === POI) tickets += item.cost;
        if (item.type === TRANSPORT && item.cost) local += 1;
        if (item.type === MEAL) food += item.cost;
        if (item.type === INTERCITY) intercity += item.cost;
      });
    });
    const stay = STAY_PER_NIGHT * Math.max(0, slots.days - 1);

    const cap = slots.budget;
    const buffer = pyRound(cap * 0.08);
    const total = intercity + local * LOCAL_FARE + stay + food + tickets + buffer;

    const budget = {
      transport: intercity + local * LOCAL_FARE,
      stay: stay, food: food, tickets: tickets,
      buffer: buffer, total: total, cap: cap
    };

    const warnings = [];
    days.forEach((d) => {
      if (d.weather.indexOf("雨") >= 0) {
        warnings.push(d.date + " 有雨，已准备室内备选：" + d.backup_indoor);
      }
    });
    const map = poiMap(city);
    days.forEach((d) => {
      d.items.forEach((item) => {
        if (item.type !== POI) return;
        const pid = poiIdByName(city, item.name);
        const tip = pid ? tipsFor(map[pid]) : "";
        if (tip && !warnings.some((w) => w.indexOf(tip) >= 0)) {
          warnings.push(item.name + "：" + tip);
        }
      });
    });

    return {
      trip_id: city.key + "-" + slots.days + "d-" + slots.people + "p",
      city: city.name,
      days: days,
      budget: budget,
      packing: packingFor(slots, days.some((d) => d.weather.indexOf("雨") >= 0)),
      roles: rolesFor(slots.people),
      warnings: warnings,
      slots: {
        days: slots.days,
        people: slots.people,
        budget: cap,
        pace: slots.pace || "标准",
        walk_limit_m: (PACE_WALK[slots.pace || "标准"] || 12) * 1000,
        tags: slots.tags || []
      }
    };
  }

  // -------------------------------------------------------------------------
  // 重排（tripmate/planner.py 后半段）
  // -------------------------------------------------------------------------

  function replacement(city, dayPlan, used, slots, freeOnly) {
    const weekday = weekdayOf(dayPlan.date);
    let candidates = city.pois.filter((p) =>
      !used.has(p.id) && p.closed !== weekday && (!freeOnly || p.cost === 0)
    );
    if (!candidates.length) return null;
    const tags = slots.tags || [];
    candidates.sort((a, b) =>
      (score(b, tags) - score(a, tags)) || (b.priority - a.priority) || byName(a.name, b.name)
    );
    return candidates[0];
  }

  function reachableReplacement(city, dayPlan, used, slots) {
    const weekday = weekdayOf(dayPlan.date);
    const candidates = city.pois.filter((p) => !used.has(p.id) && p.closed !== weekday);
    const legMin = (p) => estimateTransport(
      distanceKm(city.hotel_lat, city.hotel_lng, p.lat, p.lng), p.extra_min
    ).minutes;
    const reachable = candidates.filter((p) => legMin(p) <= 45);
    if (!reachable.length) return null;
    const tags = slots.tags || [];
    reachable.sort((a, b) =>
      (score(b, tags) - score(a, tags)) || (legMin(a) - legMin(b)) || byName(a.name, b.name)
    );
    return reachable[0];
  }

  function repairDraft(draft, plan, violations, city, slots) {
    const next = deepCopy(draft);
    const byNameMap = {};
    city.pois.forEach((p) => { byNameMap[p.name] = p; });
    const map = poiMap(city);
    const used = new Set();
    next.days.forEach((d) => d.poi_ids.forEach((id) => used.add(id)));
    const actions = [];

    const nameOf = (pid) => (map[pid] ? map[pid].name : pid);

    function drop(day, pid, why) {
      const ids = day.poi_ids;
      if (ids.indexOf(pid) >= 0 && ids.length > 1) {
        ids.splice(ids.indexOf(pid), 1);
        used.delete(pid);
        actions.push("Day" + (day.index + 1) + " 移除「" + nameOf(pid) + "」（" + why + "）");
      }
    }

    violations.forEach((v) => {
      if (v.level !== "error" || v.rule === "R6") return;
      const idx = Math.min(Math.max(v.day, 0), next.days.length - 1);
      const day = next.days[idx];
      const ids = day.poi_ids;
      const target = byNameMap[v.target] ? byNameMap[v.target].id : "";

      if (v.rule === "R5" && ids.indexOf(target) >= 0) {
        const repl = replacement(city, day, used, slots, false);
        if (repl) {
          ids[ids.indexOf(target)] = repl.id;
          used.delete(target);
          used.add(repl.id);
          actions.push("Day" + (day.index + 1) + " 「" + v.target + "」闭馆或时段冲突，替换为「" +
            repl.name + "」（R5）");
        } else {
          drop(day, target, "R5 闭馆且无替代");
        }
        return;
      }

      if (v.rule === "R2" && ids.indexOf(target) >= 0) {
        if (ids.length > 1) {
          drop(day, target, "R2 交通超时");
        } else {
          const repl = reachableReplacement(city, day, used, slots);
          if (repl) {
            ids[0] = repl.id;
            used.delete(target);
            used.add(repl.id);
            actions.push("Day" + (day.index + 1) + " 「" + v.target + "」单程超 45 分钟，换成可达的「" +
              repl.name + "」（R2）");
          }
        }
        return;
      }

      if (v.rule === "R4") {
        if (ids.indexOf(target) >= 0) {
          if (ids.length > 1) {
            drop(day, target, "R4 预算超支");
          } else {
            const repl = replacement(city, day, used, slots, true);
            if (repl) {
              ids[ids.indexOf(target)] = repl.id;
              used.delete(target);
              used.add(repl.id);
              actions.push("Day" + (day.index + 1) + " 预算超支，把付费的「" + v.target +
                "」换成免费的「" + repl.name + "」（R4）");
            }
          }
        } else {
          let paid = [];
          next.days.forEach((d) => d.poi_ids.forEach((pid) => {
            if (map[pid].cost > 0) paid.push([d, pid]);
          }));
          if (paid.length) {
            let best = paid[0];
            paid.forEach((entry) => {
              if (map[entry[1]].cost > map[best[1]].cost) best = entry;
            });
            drop(best[0], best[1], "R4 预算超支");
          }
        }
        return;
      }

      if (ids.length > 1) {
        drop(day, ids[ids.length - 1], v.rule + " 超出上限");
      }
    });

    return { draft: next, actions: actions };
  }

  // -------------------------------------------------------------------------
  // 校验（tripmate/validator.py）
  // -------------------------------------------------------------------------

  const MAX_ACTIVITY_MIN = 10 * 60;
  const MAX_LEG_MIN = 45;
  const MIN_BUFFER_RATIO = 0.08;
  const MIN_DEPART_GAP = 60;

  function lastPoiName(day) {
    for (let i = day.items.length - 1; i >= 0; i--) {
      if (day.items[i].type === POI) return day.items[i].name;
    }
    return "";
  }

  function violation(rule, level, message, fixHint, day, target) {
    return {
      rule: rule, level: level, message: message,
      fix_hint: fixHint || "", day: day || 0, target: target || ""
    };
  }

  function activityMin(day) {
    return day.items.reduce((n, i) => n + (ACTIVE_TYPES.indexOf(i.type) >= 0 ? i.minutes : 0), 0);
  }

  function poiCount(day) {
    return day.items.filter((i) => i.type === POI).length;
  }

  function validate(plan, city) {
    const out = [];
    const map = poiMap(city);
    const walkLimit = plan.slots.walk_limit_m || 12000;

    plan.days.forEach((day) => {
      const act = activityMin(day);
      if (act > MAX_ACTIVITY_MIN) {
        out.push(violation("R1", "error",
          "Day" + (day.index + 1) + " 有效活动 " + Math.floor(act / 60) + "h" +
          String(act % 60).padStart(2, "0") + "m，超过 " + Math.floor(MAX_ACTIVITY_MIN / 60) + "h 上限",
          "删减当天最远的景点", day.index, lastPoiName(day)));
      }

      day.items.forEach((item, i) => {
        if (item.type !== TRANSPORT || item.minutes <= MAX_LEG_MIN) return;
        const destItem = day.items.slice(i + 1).find((x) => x.type === POI);
        const dest = destItem ? destItem.name : "";
        const sourceItem = day.items.slice(0, i).reverse().find((x) => x.type === POI);
        const source = sourceItem ? sourceItem.name : "";
        out.push(violation("R2", "error",
          "Day" + (day.index + 1) + " 「" + (source || "住处") + " → " + (dest || "下一站") +
          "」耗时 " + item.minutes + " 分钟，超过 " + MAX_LEG_MIN + " 分钟",
          "换掉该景点或改为同区域替代", day.index, source || dest));
      });

      if (day.walk_total_m > walkLimit) {
        out.push(violation("R3", "error",
          "Day" + (day.index + 1) + " 步行 " + (day.walk_total_m / 1000).toFixed(1) +
          "km，超过体力上限 " + (walkLimit / 1000).toFixed(0) + "km",
          "同区域聚合，减少跨区移动", day.index, lastPoiName(day)));
      }

      day.items.forEach((item) => {
        if (item.type !== POI) return;
        const p = map[item.name];
        if (!p) {
          out.push(violation("R5", "warn", "「" + item.name + "」不在 POI 白名单，标记为待核实",
            "替换为库内景点或人工核实", day.index, item.name));
          return;
        }
        if (p.closed && p.closed === day.weekday) {
          out.push(violation("R5", "error",
            "「" + item.name + "」" + day.weekday + "闭馆，行程冲突",
            "换成同日开放的同类型景点", day.index, item.name));
          return;
        }
        if (clockToMin(item.start) < clockToMin(p.open_start) ||
            clockToMin(item.end) > clockToMin(p.open_end)) {
          out.push(violation("R5", "error",
            "「" + item.name + "」开放 " + p.open_start + "-" + p.open_end +
            "，行程占用 " + item.start + "-" + item.end,
            "调整到开放时段或换点", day.index, item.name));
        }
      });

      if (day.weather.indexOf("雨") >= 0) {
        if (!day.backup_indoor) {
          out.push(violation("R6", "error", "Day" + (day.index + 1) + " 有雨但没有室内备选",
            "补充室内备选或改为室内景点", day.index));
        }
      } else if (!day.backup_indoor) {
        out.push(violation("R6", "warn", "Day" + (day.index + 1) + " 缺少室内备选",
          "补充一个室内备选项", day.index));
      }
    });

    const b = plan.budget;
    if (b.total > b.cap) {
      let worst = null;
      plan.days.forEach((d) => d.items.forEach((i) => {
        if (i.type === POI && i.cost > 0 && (!worst || i.cost > worst.item.cost)) {
          worst = { day: d.index, item: i };
        }
      }));
      out.push(violation("R4", "error",
        "预算合计 ¥" + b.total + " 超过上限 ¥" + b.cap + "（含机动 ¥" + b.buffer + "）",
        "砍掉最贵的付费景点或降低住宿标准",
        worst ? worst.day : 0, worst ? worst.item.name : ""));
    } else if (b.buffer < pyRound(b.cap * MIN_BUFFER_RATIO)) {
      out.push(violation("R4", "warn", "机动预算不足 ¥" + pyRound(b.cap * MIN_BUFFER_RATIO),
        "预留应急金额", 0));
    }

    if (plan.days.length) {
      const last = plan.days[plan.days.length - 1];
      const trains = last.items.filter((i) => i.type === INTERCITY);
      const train = trains.length ? trains[trains.length - 1] : null;
      if (train) {
        let prevEnd = 0;
        last.items.forEach((i) => {
          if (i.type !== INTERCITY && i.type !== FREE) {
            prevEnd = Math.max(prevEnd, clockToMin(i.end));
          }
        });
        const gap = clockToMin(train.start) - prevEnd;
        if (gap < MIN_DEPART_GAP) {
          out.push(violation("R7", "error",
            "返程前仅留 " + gap + " 分钟缓冲，少于 " + MIN_DEPART_GAP + " 分钟",
            "末日减少景点或提前结束", last.index, lastPoiName(last)));
        }
      }
      if (poiCount(last) > 2) {
        out.push(violation("R7", "warn",
          "末日安排了 " + poiCount(last) + " 个景点，建议不超过 2 个",
          "砍掉一个景点，留出返程缓冲", last.index, lastPoiName(last)));
      }
    }
    if (plan.days.length && poiCount(plan.days[0]) > 2) {
      out.push(violation("R7", "warn",
        "首日安排了 " + poiCount(plan.days[0]) + " 个景点，行李与交通会拖慢节奏",
        "首日只留 1-2 个顺路景点", 0, lastPoiName(plan.days[0])));
    }

    return out;
  }

  function hardErrors(violations) {
    return violations.filter((v) => v.level === "error");
  }

  // -------------------------------------------------------------------------
  // 编排（tripmate/orchestrator.py）
  // -------------------------------------------------------------------------

  function draftView(draft, city) {
    const map = poiMap(city);
    return draft.days.map((day) => ({
      index: day.index,
      date: day.date,
      names: day.poi_ids.map((pid) => (map[pid] ? map[pid].name : "")).filter((n) => n)
    }));
  }

  function run(text, options) {
    const opts = options || {};
    const events = [];
    const emit = (payload) => events.push(payload);

    const raw = extract(text, opts.today);
    if (opts.city) raw.city = opts.city;
    if (opts.start) raw.start = opts.start;
    ["days", "people", "budget"].forEach((key) => {
      if (opts[key] !== undefined && opts[key] !== null && opts[key] !== "") {
        raw[key] = Number(opts[key]);
      }
    });

    const missing = missingSlots(raw);
    const slots = fillDefaults(raw);
    const notes = missing.map((m) => "未提到「" + m + "」，按默认值补齐");

    const city = CITIES[slots.city];
    if (!city) {
      const supported = Object.keys(CITIES).map((k) => CITIES[k].name).join(" / ");
      throw new Error("暂不支持城市「" + slots.city + "」，当前离线数据只有：" + supported);
    }

    emit({ stage: "slots", slots: slots, missing: missing, notes: notes.slice(), city: city.name });

    let draft = makeDraft(slots, city);
    notes.push("选点：离线规则版（纯前端运行，不调用大模型）");
    emit({ stage: "draft", source: "rule", days: draftView(draft, city) });

    let plan = assemble(slots, draft, city);
    let violations = validate(plan, city);
    emit({
      stage: "check", round: 0,
      violations: violations.map((v) => v),
      error_count: hardErrors(violations).length
    });

    const rounds = [{ round: 0, violations: violations.slice(), actions: [] }];
    const maxRounds = opts.rounds === undefined ? 2 : opts.rounds;

    for (let roundNo = 1; roundNo <= maxRounds; roundNo++) {
      if (!hardErrors(violations).length) break;
      const repaired = repairDraft(draft, plan, hardErrors(violations), city, slots);
      draft = repaired.draft;
      const actions = repaired.actions;
      plan = assemble(slots, draft, city);
      violations = validate(plan, city);
      rounds.push({ round: roundNo, violations: violations.slice(), actions: actions });
      emit({ stage: "repair", round: roundNo, actions: actions, days: draftView(draft, city) });
      emit({
        stage: "check", round: roundNo,
        violations: violations.map((v) => v),
        error_count: hardErrors(violations).length
      });
      if (!actions.length) break;
    }

    const finalErrors = hardErrors(violations);
    violations.forEach((v) => {
      if (v.level === "warn") plan.warnings.push("[" + v.rule + "] " + v.message);
    });
    if (finalErrors.length) {
      notes.push("仍有 " + finalErrors.length + " 条硬约束未满足，已按宽松版输出，请人工确认");
    }

    const result = {
      slots: slots,
      plan: plan,
      rounds: rounds.map((r) => ({
        round: r.round,
        errors: r.violations.map((v) => v),
        actions: r.actions
      })),
      notes: notes
    };
    const ok = finalErrors.length === 0;
    emit({ stage: "final", ok: ok, result: result });
    return { ok: ok, events: events, slots: slots, plan: plan, rounds: rounds, notes: notes, result: result };
  }

  // -------------------------------------------------------------------------
  // 导出（tripmate/export.py）
  // -------------------------------------------------------------------------

  const TYPE_LABEL = {
    poi: "景点", meal: "餐饮", transport: "交通", intercity: "城际", free: "机动"
  };

  const INK = "#1B1F1B";
  const MUTED = "#68706A";
  const BRAND = "#0F7A4A";
  const SOFT = "#E7F4EC";
  const LINE = "#DDE4DE";
  const CANVAS = "#F7F9F7";
  const WARN = "#9A5B12";

  function icsText(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;")
      .replace(/,/g, "\\,").replace(/\n/g, "\\n");
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function icsTime(day, minutes) {
    const parts = day.split("-").map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0);
    dt.setMinutes(dt.getMinutes() + minutes);
    return "" + dt.getFullYear() + pad2(dt.getMonth() + 1) + pad2(dt.getDate()) +
      "T" + pad2(dt.getHours()) + pad2(dt.getMinutes()) + pad2(dt.getSeconds());
  }

  function nowStamp() {
    const d = new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      "T" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function toICS(result) {
    const plan = result.plan;
    const stamp = nowStamp();
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//TripMate//行程导出//CN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:" + icsText("旅搭 · " + plan.city + " " + plan.days.length + " 天")
    ];
    plan.days.forEach((day) => {
      day.items.forEach((item) => {
        if (item.type === FREE) return;
        const startMin = clockToMin(item.start);
        const endMin = startMin + item.minutes;
        let desc = (TYPE_LABEL[item.type] || item.type) + "｜" + day.date + " " + day.weather;
        if (item.cost) desc += "｜人均 ¥" + item.cost;
        if (item.walk_m) desc += "｜步行 " + (item.walk_m / 1000).toFixed(1) + "km";
        lines.push(
          "BEGIN:VEVENT",
          "UID:" + plan.trip_id + "-" + day.date + "-" + item.id + "@tripmate",
          "DTSTAMP:" + stamp,
          "DTSTART:" + icsTime(day.date, startMin),
          "DTEND:" + icsTime(day.date, endMin),
          "SUMMARY:" + icsText(item.name),
          "DESCRIPTION:" + icsText(desc),
          "LOCATION:" + icsText(item.name),
          "END:VEVENT"
        );
      });
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }

  function xmlEscape(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }

  function fit(value, limit) {
    const chars = Array.from(String(value));
    return chars.length <= limit ? chars.join("") : chars.slice(0, limit - 1).join("") + "…";
  }

  function bar(x, y, width, ratio, color) {
    const r = Math.max(0, Math.min(1, ratio));
    return [
      '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="6" rx="3" fill="' + LINE + '"/>',
      '<rect x="' + x + '" y="' + y + '" width="' + Math.max(2, Math.trunc(width * r)) +
        '" height="6" rx="3" fill="' + color + '"/>'
    ];
  }

  function toSVG(result) {
    const plan = result.plan;
    const slots = result.slots;
    const width = 920;
    const margin = 48;
    const dayRows = plan.days.map((d) => d.items.length);
    const budgetH = 168;
    const checkH = 116;
    const footerH = 110;
    const height = 170 + dayRows.reduce((n, rows) => n + 66 + rows * 42 + 16, 0) +
      budgetH + checkH + footerH;

    const out = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
        '" viewBox="0 0 ' + width + ' ' + height +
        '" font-family="PingFang SC, Microsoft YaHei, sans-serif">',
      '<rect width="' + width + '" height="' + height + '" fill="' + CANVAS + '"/>'
    ];

    out.push(
      '<rect x="0" y="0" width="' + width + '" height="8" fill="' + BRAND + '"/>',
      '<text x="' + margin + '" y="72" font-size="30" font-weight="700" fill="' + INK + '">旅搭 TripMate</text>',
      '<text x="' + margin + '" y="104" font-size="15" fill="' + MUTED + '">' +
        xmlEscape(plan.city) + " · " + slots.days + " 天 · " + slots.people + " 人 · 人均 ¥" +
        slots.budget + " · " + xmlEscape(slots.pace || "标准") + "节奏</text>",
      '<text x="' + margin + '" y="128" font-size="13" fill="' + MUTED + '">' +
        xmlEscape(fit(slots.raw || "", 46)) + "</text>"
    );

    const ok = result.ok === true;
    const badgeText = ok ? "R1–R7 全部通过" : "仍有约束待人工确认";
    const badgeW = ok ? 168 : 208;
    out.push(
      '<rect x="' + (width - margin - badgeW) + '" y="52" width="' + badgeW +
        '" height="40" rx="20" fill="' + (ok ? SOFT : "#FDF1DF") + '"/>',
      '<text x="' + (width - margin - badgeW + 22) + '" y="78" font-size="14" font-weight="600" fill="' +
        (ok ? BRAND : WARN) + '">' + badgeText + "</text>"
    );

    let y = 170;
    plan.days.forEach((day) => {
      out.push(
        '<rect x="' + margin + '" y="' + y + '" width="' + (width - margin * 2) +
          '" height="50" rx="10" fill="' + SOFT + '"/>',
        '<text x="' + (margin + 16) + '" y="' + (y + 22) + '" font-size="15" font-weight="700" fill="' +
          BRAND + '">Day ' + (day.index + 1) + " · " + day.date + " " + day.weekday + "</text>",
        '<text x="' + (margin + 16) + '" y="' + (y + 41) + '" font-size="12" fill="' + MUTED + '">' +
          day.weather + " · 步行 " + (day.walk_total_m / 1000).toFixed(1) +
          " km · 景点 " + poiCount(day) + " 个</text>"
      );
      let rowY = y + 50 + 8;
      day.items.forEach((item) => {
        const dot = item.type === POI ? BRAND : LINE;
        out.push('<circle cx="' + (margin + 18) + '" cy="' + (rowY + 20) + '" r="4" fill="' + dot + '"/>');
        out.push(
          '<text x="' + (margin + 36) + '" y="' + (rowY + 25) + '" font-size="13" fill="' + MUTED +
            '" font-family="SFMono-Regular, Consolas, monospace">' + item.start + "-" + item.end + "</text>"
        );
        out.push(
          '<text x="' + (margin + 156) + '" y="' + (rowY + 25) + '" font-size="13" fill="' + MUTED + '">' +
            (TYPE_LABEL[item.type] || item.type) + "</text>"
        );
        out.push(
          '<text x="' + (margin + 208) + '" y="' + (rowY + 25) + '" font-size="14" fill="' +
            (item.type === POI ? INK : MUTED) + '">' + xmlEscape(fit(item.name, 30)) + "</text>"
        );
        if (item.cost) {
          out.push(
            '<text x="' + (width - margin - 8) + '" y="' + (rowY + 25) +
              '" font-size="13" fill="' + MUTED + '" text-anchor="end">¥' + item.cost + "</text>"
          );
        }
        rowY += 42;
      });
      y = rowY + 16;
    });

    const b = plan.budget;
    const cells = [["交通", b.transport], ["住宿", b.stay], ["餐饮", b.food],
      ["门票", b.tickets], ["机动", b.buffer]];
    out.push(
      '<text x="' + margin + '" y="' + (y + 4) + '" font-size="16" font-weight="700" fill="' + INK + '">' +
        "人均预算 ¥" + b.total + ' <tspan font-size="12" font-weight="400" fill="' + MUTED + '">/ 上限 ¥' +
        b.cap + "</tspan></text>"
    );
    out.push.apply(out, bar(margin, y + 18, width - margin * 2, b.cap ? b.total / b.cap : 0, BRAND));
    const cellW = (width - margin * 2) / cells.length;
    cells.forEach((cell, i) => {
      const cx = Math.trunc(margin + cellW * i);
      out.push(
        '<text x="' + cx + '" y="' + (y + 58) + '" font-size="12" fill="' + MUTED + '">' + cell[0] + "</text>",
        '<text x="' + cx + '" y="' + (y + 82) + '" font-size="18" font-weight="700" fill="' + INK + '">¥' +
          cell[1] + "</text>"
      );
    });
    y += budgetH;

    const rounds = result.rounds || [];
    const baseline = (rounds[0].violations || rounds[0].errors || [])
      .filter((v) => v.level === "error");
    const actions = [];
    rounds.slice(1).forEach((r) => r.actions.forEach((a) => actions.push(a)));
    out.push('<text x="' + margin + '" y="' + y + '" font-size="14" font-weight="700" fill="' + INK +
      '">校验-重排闭环</text>');
    const lastRound = rounds[rounds.length - 1] || { violations: [], errors: [] };
    const lastErrors = (lastRound.violations || lastRound.errors || [])
      .filter((v) => v.level === "error").length;
    out.push(
      '<text x="' + margin + '" y="' + (y + 26) + '" font-size="13" fill="' + MUTED + '">' +
        "基线硬约束 " + baseline.length + " 条 → 重排 " + (rounds.length - 1) + " 轮 → 最终 " +
        (ok ? "通过" : "仍有 " + lastErrors + " 条未满足") + "</text>"
    );
    actions.slice(0, 3).forEach((action, i) => {
      out.push('<text x="' + margin + '" y="' + (y + 50 + i * 20) + '" font-size="12" fill="' + BRAND +
        '">→ ' + xmlEscape(fit(action, 52)) + "</text>");
    });
    y = height - footerH + 40;
    const rolesText = plan.roles.map((r) => r.owner + " " + r.task).join(" · ");

    out.push(
      '<line x1="' + margin + '" y1="' + y + '" x2="' + (width - margin) + '" y2="' + y +
        '" stroke="' + LINE + '" stroke-width="1"/>',
      '<text x="' + margin + '" y="' + (y + 34) + '" font-size="12" fill="' + MUTED + '">行李：' +
        xmlEscape(fit(plan.packing.join(" / "), 62)) + "</text>",
      '<text x="' + margin + '" y="' + (y + 60) + '" font-size="12" fill="' + MUTED + '">同伴分工：' +
        xmlEscape(fit(rolesText, 62)) + "</text>",
      '<text x="' + margin + '" y="' + (y + 86) + '" font-size="11" fill="' + MUTED + '">' +
        "POI 来自白名单，行程经 R1–R7 校验；由 TripMate 生成</text>",
      "</svg>"
    );
    return out.join("\n");
  }

  // -------------------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------------------

  const TripMate = {
    CITIES: CITIES,
    run: run,
    toICS: toICS,
    toSVG: toSVG,
    distanceKm: distanceKm,
    estimateTransport: estimateTransport
  };

  if (typeof window !== "undefined") window.TripMate = TripMate;
  if (typeof module !== "undefined" && module.exports) module.exports = TripMate;
})(typeof globalThis !== "undefined" ? globalThis : this);
