// The kinds of everyday matters in the background library. Each kind makes one matter's
// material from a random source and the date it was first mentioned: the title, the goal,
// the user's first words, optional details (each a sentence plus what it adds to the
// constraint or the plan), what the user says at the end for each state, and sometimes an
// assistant's inference. library.mjs decides which parts a matter gets, so its facts are
// always built from the words it actually holds.
import { between, pick } from './util.mjs';

const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

/** The year and month `ahead` months after `date`. */
export function monthAhead(date, ahead) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + ahead);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

const day = (r) => between(r, 3, 27);
const money = (r, low, high, step) => step * between(r, Math.ceil(low / step), Math.floor(high / step));

export const CITIES = ['成都', '重庆', '西安', '杭州', '苏州', '南京', '厦门', '青岛', '大连', '昆明', '大理', '桂林', '长沙',
  '武汉', '哈尔滨', '三亚', '泉州', '洛阳', '敦煌', '贵阳', '黄山', '景德镇', '潮州', '北海', '威海', '天津', '珠海', '扬州'];
export const ABROAD = ['东京', '大阪', '京都', '首尔', '清迈', '新加坡', '槟城', '岘港', '墨尔本', '奥克兰', '里斯本', '巴塞罗那',
  '伊斯坦布尔', '雷克雅未克', '巴厘岛', '札幌'];

const COMPANIONS = [
  { tag: '和爱人', phrase: '和爱人', wait: '在等爱人确认时间' },
  { tag: '和我妈', phrase: '带我妈', wait: '在等我妈确认时间' },
  { tag: '一个人', phrase: '一个人', wait: '在等领导批假' },
  { tag: '和大学室友', phrase: '和大学室友', wait: '在等室友确认时间' },
  { tag: '带爸妈', phrase: '带爸妈', wait: '在等我爸确认时间' },
];

const tripOutcomes = (place, when, companion) => ({
  active: { say: `票买好了，${when}出发。`, progress: `票已买好，${when}出发。`, plan: `${when}出发` },
  done: { say: `${place}玩回来了，挺开心的。`, progress: '已经玩回来了。' },
  cancelled: (r) => {
    const why = pick(r, ['假期调不开', '家里临时有事', '机票太贵了', '那几天天气不好']);
    return { say: `${place}那趟不去了，${why}。`, progress: `取消了：${why}。` };
  },
  waiting: { say: `${companion.wait}，定了再买票。`, progress: `${companion.wait}。` },
  dormant: { say: `${place}的事先放一放，最近太忙。`, progress: '先放着，最近太忙。' },
});

export const EVERYDAY = [
  {
    kind: 'trip',
    make(r, start) {
      const city = pick(r, CITIES);
      const { y, m } = monthAhead(start, between(r, 1, 3));
      const n = between(r, 2, 5);
      const c = pick(r, COMPANIONS);
      const when = `${m}月${day(r)}号`;
      const budget = money(r, 2000, 9000, 500);
      const area = pick(r, ['老城区', '地铁站', '江边', '古城', '市中心', '海边']);
      const food = pick(r, ['小吃', '海鲜', '火锅', '米粉', '早茶', '烧烤']);
      return {
        title: `${y} 年 ${m} 月${city}${CN[n]}日游（${c.tag}）`,
        goal: `${m} 月${c.phrase}去${city}玩 ${n} 天。`,
        start: `${m}月想${c.phrase}去${city}玩${CN[n]}天。`,
        details: [
          { say: `这趟预算控制在 ${budget} 元以内。`, constraint: `预算 ${budget} 元以内` },
          { say: `酒店想住${area}附近，方便走路。`, constraint: `想住${area}附近` },
          { say: pick(r, ['去程坐高铁，回程再看。', '机票看了，坐早上那班。']), plan: pick(r, ['去程坐高铁', '坐早班飞机去']) },
          { say: `这次主要是想吃当地的${food}。`, constraint: `想吃当地的${food}` },
        ],
        outcomes: tripOutcomes(city, when, c),
        inference: { say: '推测：更想坐高铁，不想坐飞机（依据：用户说过怕航班晚点）。', constraint: '推测更想坐高铁（依据：用户说过怕航班晚点）' },
      };
    },
  },
  {
    kind: 'abroad',
    make(r, start) {
      const place = pick(r, ABROAD);
      const { y, m } = monthAhead(start, between(r, 2, 4));
      const c = pick(r, COMPANIONS);
      const when = `${m}月${day(r)}号`;
      const budget = money(r, 6000, 20000, 1000);
      return {
        title: `${y} 年 ${m} 月去${place}（${c.tag}）`,
        goal: `${m} 月${c.phrase}去${place}玩一周左右。`,
        start: `${m}月想${c.phrase}去${place}玩一周。`,
        details: [
          { say: `人均预算 ${budget} 元。`, constraint: `人均预算 ${budget} 元` },
          { say: '签证得提前一个月办。', plan: '提前一个月办签证' },
          { say: '住的地方想离地铁近一点。', constraint: '住处离地铁近' },
          { say: '这次不想跟团，自由行。', plan: '自由行，不跟团' },
        ],
        outcomes: tripOutcomes(place, when, c),
        inference: { say: '推测：预算可能还要再加一点（依据：用户说过想住好一点的酒店）。', constraint: '推测预算还要再加一点（依据：用户说过想住好一点的酒店）' },
      };
    },
  },
  {
    kind: 'purchase',
    make(r, start) {
      const [item, low, high, feature] = pick(r, [
        ['笔记本电脑', 6000, 10000, '轻一点，方便带着出门'], ['洗碗机', 3000, 5000, '能放进橱柜'],
        ['扫地机器人', 2000, 4000, '能自己倒垃圾'], ['投影仪', 3000, 6000, '白天也能看清'],
        ['公路自行车', 4000, 8000, '车架轻一点'], ['相机镜头', 5000, 9000, '能拍人像'],
        ['床垫', 3000, 6000, '偏硬一点'], ['空气净化器', 1500, 3000, '声音小'],
        ['降噪耳机', 1500, 2500, '戴久了耳朵不疼'], ['人体工学椅', 1500, 3500, '腰托能调'],
        ['电视', 4000, 8000, '65 寸'], ['冰箱', 4000, 7000, '对开门'],
        ['跑步机', 3000, 5000, '能折叠'], ['咖啡机', 1500, 4000, '能打奶泡'],
        ['平板电脑', 3000, 6000, '能用笔写字'], ['显示器', 1500, 3000, '4K 的'],
        ['净水器', 2000, 4000, '不用经常换滤芯'], ['智能门锁', 1500, 2500, '能指纹开锁'],
      ]);
      const { y, m } = monthAhead(start, 0);
      const budget = money(r, low, high, 500);
      const sale = pick(r, ['双十一', '618', '年货节', '店庆']);
      const raise = budget + money(r, 500, 1500, 500);
      return {
        title: `${y} 年 ${m} 月买${item}`,
        goal: `买一个${item}。`,
        start: `想买个${item}，预算 ${budget} 左右。`,
        startConstraint: `预算 ${budget} 元左右`,
        details: [
          { say: `最好${feature}。`, constraint: `最好${feature}` },
          { say: `等${sale}再下单。`, plan: `等${sale}再下单` },
          { say: '颜色要白色的，和家里搭。', constraint: '要白色' },
        ],
        outcomes: {
          active: { say: `${item}看中了一款，等降价。`, progress: '看中了一款，等降价。' },
          done: { say: `${item}买了，昨天到的。`, progress: '已经买了，到货了。' },
          cancelled: (rr) => {
            const why = pick(rr, ['家里放不下', '用不上几次', '想等新款出来']);
            return { say: `${item}先不买了，${why}。`, progress: `不买了：${why}。` };
          },
          waiting: { say: '下单了，在等发货。', progress: '已下单，等发货。' },
          dormant: { say: `${item}的事先缓缓。`, progress: '先缓一缓。' },
        },
        inference: { say: `推测：预算可以放宽到 ${raise} 元（依据：用户说过质量比价格重要）。`, constraint: `推测预算可以放宽到 ${raise} 元（依据：用户说过质量比价格重要）` },
      };
    },
  },
  {
    kind: 'learning',
    make(r, start) {
      const skill = pick(r, ['吉他', '尤克里里', '钢琴', '西班牙语', '粤语', '游泳', '素描', '水彩', 'Python', '摄影后期',
        '剪视频', '书法', '围棋', '滑板', '攀岩', '网球', '羽毛球', '烘焙', '插花', '法语']);
      const { y } = monthAhead(start, 0);
      const times = between(r, 2, 4);
      const price = money(r, 800, 4000, 100);
      const weeks = between(r, 3, 12);
      return {
        title: `${y} 年学${skill}`,
        goal: `${y} 年把${skill}学起来。`,
        start: `今年想把${skill}学起来。`,
        details: [
          { say: `每周练${CN[times]}次，每次一小时。`, plan: `每周练 ${times} 次，每次一小时` },
          { say: `报了个班，${price} 块。`, plan: '报了一个班', constraint: `课程费用 ${price} 元` },
          { say: '只能周末上课，工作日没时间。', constraint: '只能周末上课' },
        ],
        outcomes: {
          active: { say: `${skill}已经练了${weeks}周了。`, progress: `已经练了 ${weeks} 周。` },
          done: { say: `${skill}的课上完了，基础算是有了。`, progress: '课上完了，基础有了。' },
          cancelled: { say: `${skill}不学了，实在挤不出时间。`, progress: '不学了：挤不出时间。' },
          waiting: { say: '在等班里凑够人开课。', progress: '在等开课。' },
          dormant: { say: `${skill}停了一阵，工作太忙。`, progress: '停了一阵，工作太忙。' },
        },
        inference: { say: '推测：更适合线下课（依据：用户说过线上课坚持不下来）。', constraint: '推测更适合线下课（依据：用户说过线上课坚持不下来）' },
      };
    },
  },
  {
    kind: 'health',
    make(r, start) {
      const [item, place] = pick(r, [['体检', '社区医院'], ['洗牙', '口腔医院'], ['配眼镜', '眼镜店'], ['复查膝盖', '骨科门诊'],
        ['打流感疫苗', '社区医院'], ['拔智齿', '口腔医院'], ['查视力', '眼科医院'], ['理疗腰', '康复科']]);
      const { y, m } = monthAhead(start, between(r, 0, 1));
      const when = `${m}月${day(r)}号上午`;
      return {
        title: `${y} 年 ${m} 月${item}`,
        goal: `${m} 月把${item}做了。`,
        start: `${m}月要去${item}。`,
        details: [
          { say: `约在${place}。`, plan: `在${place}` },
          { say: `时间定在${when}。`, plan: `${when}` },
          { say: '得请半天假。', constraint: '要请半天假' },
        ],
        outcomes: {
          active: { say: `${item}约好了，${when}。`, progress: `约好了，${when}。` },
          done: { say: `${item}做完了，${pick(r, ['没什么问题', '医生说要多运动', '下次半年后再去'])}。`, progress: '已经做完了。' },
          cancelled: { say: `${item}先不去了，改到明年。`, progress: '不去了，改到明年。' },
          waiting: { say: `在等${place}放号。`, progress: `在等${place}放号。` },
          dormant: { say: `${item}的事拖一拖。`, progress: '先拖着。' },
        },
      };
    },
  },
  {
    kind: 'repair',
    make(r, start) {
      const [item, problem] = pick(r, [['卫生间漏水', '卫生间天花板在滴水'], ['厨房水龙头', '厨房水龙头关不紧'],
        ['阳台晾衣架', '阳台的晾衣架摇不动了'], ['客厅墙面补漆', '客厅墙上掉了一块漆'], ['换门锁', '门锁老是卡住'],
        ['修空调', '卧室空调不制冷了'], ['换热水器', '热水器打不着火'], ['修洗衣机', '洗衣机甩干的时候响得厉害']]);
      const { y, m } = monthAhead(start, 0);
      const quote = money(r, 150, 1500, 50);
      return {
        title: `${y} 年 ${m} 月${item}`,
        goal: `把${item}的问题解决。`,
        start: `${problem}，得找人来修。`,
        details: [
          { say: `师傅说要 ${quote} 块。`, constraint: `报价 ${quote} 元` },
          { say: '只能周末上门，工作日家里没人。', constraint: '只能周末上门' },
          { say: '物业说可以帮忙找师傅。', plan: '通过物业找师傅' },
        ],
        outcomes: {
          active: { say: '约了师傅这周六来。', progress: '约了师傅周六上门。' },
          done: { say: `${item}弄好了。`, progress: '已经修好了。' },
          cancelled: { say: `${item}不找人了，自己弄好了。`, progress: '自己弄好了，不用找人。' },
          waiting: { say: '在等师傅回电话。', progress: '在等师傅回电话。' },
          dormant: { say: `${item}先凑合用着。`, progress: '先凑合着。' },
        },
      };
    },
  },
  {
    kind: 'car',
    make(r, start) {
      const item = pick(r, ['保养', '年检', '换轮胎', '续车险', '换雨刮', '补漆']);
      const { y, m } = monthAhead(start, between(r, 0, 1));
      const cost = money(r, 300, 3000, 100);
      return {
        title: `${y} 年 ${m} 月车子${item}`,
        goal: `${m} 月把车子的${item}弄好。`,
        start: `车子${m}月该${item}了。`,
        details: [
          { say: `4S 店报价 ${cost}，有点贵。`, constraint: `4S 店报价 ${cost} 元，嫌贵` },
          { say: '想去小区门口那家修车店问问。', plan: '去小区门口的修车店问价' },
          { say: '最好周六上午去。', constraint: '周六上午去' },
        ],
        outcomes: {
          active: { say: `${item}约在下周六。`, progress: '约在下周六。' },
          done: { say: `车子${item}做完了。`, progress: '已经做完了。' },
          cancelled: { say: `${item}不做了，过段时间再说。`, progress: '不做了。' },
          waiting: { say: '在等店里到配件。', progress: '在等配件。' },
          dormant: { say: `${item}的事先放着。`, progress: '先放着。' },
        },
      };
    },
  },
  {
    kind: 'pet',
    make(r, start) {
      const pet = pick(r, ['猫', '狗']);
      const item = pick(r, ['打疫苗', '驱虫', '绝育', '体检', '洗澡美容', '寄养']);
      const { y, m } = monthAhead(start, 0);
      return {
        title: `${y} 年 ${m} 月给${pet}${item}`,
        goal: `给家里的${pet}${item}。`,
        start: `家里的${pet}该${item}了。`,
        details: [
          { say: '去上次那家宠物医院。', plan: '去上次那家宠物医院' },
          { say: '费用别超过 500。', constraint: '费用 500 元以内' },
        ],
        outcomes: {
          active: { say: '约了周末上午。', progress: '约了周末上午。' },
          done: { say: `${pet}${item}弄完了，挺乖的。`, progress: '已经弄完了。' },
          cancelled: { say: `${item}先不弄了，医生说不急。`, progress: '不急，先不弄。' },
          waiting: { say: '在等医院排期。', progress: '在等医院排期。' },
          dormant: { say: '这事过阵子再说。', progress: '过阵子再说。' },
        },
      };
    },
  },
  {
    kind: 'family',
    make(r, start) {
      const [event, plan] = pick(r, [['我妈生日', '订一家粤菜馆吃饭'], ['我爸生日', '在家做一桌菜'], ['表弟婚礼', '提前一天到'],
        ['外婆八十大寿', '全家一起回老家'], ['侄子满月酒', '包个红包'], ['爸妈结婚纪念日', '给他们订个旅行团'],
        ['舅舅家乔迁', '买个礼物带过去']]);
      const { y, m } = monthAhead(start, between(r, 1, 2));
      const gift = money(r, 500, 3000, 100);
      return {
        title: `${y} 年${event}`,
        goal: `${m} 月把${event}安排好。`,
        start: `${m}月是${event}，得提前准备。`,
        details: [
          { say: `打算${plan}。`, plan },
          { say: `礼物或者红包 ${gift} 左右。`, constraint: `礼物或红包 ${gift} 元左右` },
          { say: '我爱人说要提前一周定下来。', constraint: '提前一周定下来' },
        ],
        outcomes: {
          active: { say: `${event}的事安排得差不多了。`, progress: '安排得差不多了。' },
          done: { say: `${event}办完了，大家都挺高兴。`, progress: '已经办完了。' },
          cancelled: { say: `${event}今年不办了，家里说简单点。`, progress: '今年不办了。' },
          waiting: { say: '在等我妈定日子。', progress: '在等我妈定日子。' },
          dormant: { say: '这事还早，先放着。', progress: '还早，先放着。' },
        },
      };
    },
  },
  {
    kind: 'project',
    make(r, start) {
      const [project, step] = pick(r, [['做一个记账小程序', '先把记一笔的功能做出来'], ['开一个摄影公众号', '先攒十篇稿子'],
        ['写一本短篇小说集', '每周写一篇'], ['做一档播客', '先录三期试试'], ['拍一组城市夜景', '每周末出去拍一次'],
        ['做一个家用 NAS', '先买硬盘'], ['整理家里的老照片', '先扫描到电脑里']]);
      const { y } = monthAhead(start, 0);
      return {
        title: `${y} 年${project}`,
        goal: `${project}。`,
        start: `我想${project}。`,
        details: [
          { say: `${step}。`, plan: step },
          { say: '每周最多花五个小时。', constraint: '每周最多五小时' },
          { say: '不想花太多钱，几百块以内。', constraint: '花费几百元以内' },
        ],
        outcomes: {
          active: { say: '已经开了个头。', progress: '已经开了个头。' },
          done: { say: '做完了，比想的顺利。', progress: '已经做完了。' },
          cancelled: { say: '这个不做了，没意思了。', progress: '不做了。' },
          waiting: { say: '在等朋友帮忙看看。', progress: '在等朋友帮忙看。' },
          dormant: { say: '这阵子没空，停一停。', progress: '停一停。' },
        },
      };
    },
  },
  {
    kind: 'paperwork',
    make(r, start) {
      const [item, where] = pick(r, [['护照换发', '出入境大厅'], ['居住证续签', '派出所'], ['公积金提取', '公积金中心'],
        ['个税汇算', '个税 App'], ['驾照换证', '车管所'], ['社保转移', '社保局'], ['港澳通行证续签', '出入境大厅']]);
      const { y, m } = monthAhead(start, 0);
      return {
        title: `${y} 年 ${m} 月${item}`,
        goal: `把${item}办完。`,
        start: `${item}要办了，${m}月底前。`,
        startConstraint: `${m} 月底前办完`,
        details: [
          { say: `要去${where}，得预约。`, plan: `去${where}，先预约` },
          { say: '材料要带身份证和照片。', plan: '带身份证和照片' },
        ],
        outcomes: {
          active: { say: '预约好了，下周三去。', progress: '预约好了，下周三去。' },
          done: { say: `${item}办好了。`, progress: '已经办好了。' },
          cancelled: { say: `${item}暂时不用办了。`, progress: '暂时不用办了。' },
          waiting: { say: '材料交了，在等审核。', progress: '材料已交，等审核。' },
          dormant: { say: '这事不急，先放着。', progress: '不急，先放着。' },
        },
      };
    },
  },
  {
    kind: 'insurance',
    make(r, start) {
      const [item, who] = pick(r, [['医疗险', '爸妈'], ['重疾险续保', '自己'], ['意外险', '自己'], ['宠物险', '家里的猫'],
        ['家财险', '家里']]);
      const { y, m } = monthAhead(start, 0);
      const premium = money(r, 300, 6000, 100);
      return {
        title: `${y} 年 ${m} 月给${who}买${item}`,
        goal: `给${who}把${item}买好。`,
        start: `想给${who}买个${item}。`,
        details: [
          { say: `一年保费控制在 ${premium} 以内。`, constraint: `年保费 ${premium} 元以内` },
          { say: '要能报门诊的。', constraint: '要能报门诊' },
        ],
        outcomes: {
          active: { say: '看了两款，在比。', progress: '看了两款，在比较。' },
          done: { say: `${item}买好了。`, progress: '已经买好了。' },
          cancelled: { say: `${item}先不买了。`, progress: '先不买了。' },
          waiting: { say: '在等保险公司核保。', progress: '在等核保。' },
          dormant: { say: '这个以后再说。', progress: '以后再说。' },
        },
      };
    },
  },
  {
    kind: 'subscription',
    make(r, start) {
      const [item, how] = pick(r, [['视频会员', '取消自动续费'], ['云盘', '扩容到 2T'], ['宽带', '换成千兆的套餐'],
        ['手机套餐', '换个流量多的'], ['音乐会员', '换成家庭版']]);
      const { y, m } = monthAhead(start, 0);
      return {
        title: `${y} 年 ${m} 月调整${item}`,
        goal: `${item}${how}。`,
        start: `${item}想${how}。`,
        details: [
          { say: '每个月别超过 100 块。', constraint: '每月 100 元以内' },
          { say: '月底到期前弄好。', constraint: '月底到期前弄好' },
        ],
        outcomes: {
          active: { say: '在对比几家的价格。', progress: '在对比价格。' },
          done: { say: `${item}弄好了。`, progress: '已经弄好了。' },
          cancelled: { say: `${item}不改了，就这样吧。`, progress: '不改了。' },
          waiting: { say: '在等客服回复。', progress: '在等客服回复。' },
          dormant: { say: '这事先不管了。', progress: '先不管了。' },
        },
      };
    },
  },
  {
    kind: 'gift',
    make(r, start) {
      const [who, idea, occasions] = pick(r, [['爱人', '一条项链', ['生日', '结婚纪念日']], ['我妈', '一台按摩仪', ['生日']],
        ['我爸', '一个保温杯', ['生日']], ['同事', '一套茶具', ['结婚', '升职']], ['侄子', '一套积木', ['生日']],
        ['大学室友', '一瓶好酒', ['结婚', '生日']]]);
      const occasion = pick(r, occasions);
      const { y, m } = monthAhead(start, between(r, 0, 1));
      const budget = money(r, 200, 3000, 100);
      return {
        title: `${y} 年 ${m} 月给${who}的${occasion}礼物`,
        goal: `给${who}准备${occasion}礼物。`,
        start: `${m}月要给${who}准备${occasion}礼物。`,
        details: [
          { say: `想送${idea}。`, plan: `送${idea}` },
          { say: `预算 ${budget} 以内。`, constraint: `预算 ${budget} 元以内` },
        ],
        outcomes: {
          active: { say: '礼物看好了，过两天下单。', progress: '看好了，过两天下单。' },
          done: { say: '礼物送出去了，很喜欢。', progress: '已经送了。' },
          cancelled: { say: '礼物不准备了，改成一起吃顿饭。', progress: '改成一起吃饭。' },
          waiting: { say: '下单了，在等快递。', progress: '在等快递。' },
          dormant: { say: '礼物的事还没想好。', progress: '还没想好。' },
        },
      };
    },
  },
  {
    kind: 'event',
    make(r, start) {
      const [show, city] = pick(r, [['演唱会', pick(r, CITIES)], ['话剧', '本地'], ['音乐节', pick(r, CITIES)], ['看展', '本地'],
        ['相声专场', '本地'], ['足球比赛', '本地']]);
      const { y, m } = monthAhead(start, between(r, 1, 2));
      const price = money(r, 200, 1500, 100);
      const where = city === '本地' ? '' : `去${city}`;
      return {
        title: `${y} 年 ${m} 月${where}看${show}`,
        goal: `${m} 月${where}看一场${show}。`,
        start: `${m}月想${where}看${show}。`,
        details: [
          { say: `票价 ${price} 以内都行。`, constraint: `票价 ${price} 元以内` },
          { say: '要两张票，和爱人一起。', plan: '买两张票，和爱人一起' },
        ],
        outcomes: {
          active: { say: '票抢到了。', progress: '票已抢到。' },
          done: { say: `${show}看完了，很值。`, progress: '已经看完了。' },
          cancelled: { say: '没抢到票，算了。', progress: '没抢到票，不去了。' },
          waiting: { say: '在等开票。', progress: '在等开票。' },
          dormant: { say: '这个再看吧。', progress: '再看。' },
        },
      };
    },
  },
  {
    kind: 'cooking',
    make(r, start) {
      const dish = pick(r, ['红烧肉', '糖醋排骨', '鱼香肉丝', '番茄牛腩', '清蒸鱼', '麻婆豆腐', '可乐鸡翅', '酸菜鱼']);
      const { y, m } = monthAhead(start, 0);
      return {
        title: `${y} 年 ${m} 月学做${dish}`,
        goal: `学会做${dish}。`,
        start: `想学做${dish}，周末试试。`,
        details: [
          { say: '照着视频做，先做两人份。', plan: '照视频做两人份' },
          { say: '我爱人不吃太辣的。', constraint: '不能太辣' },
        ],
        outcomes: {
          active: { say: `${dish}试了一次，有点咸。`, progress: '试了一次，偏咸。' },
          done: { say: `${dish}学会了，味道不错。`, progress: '已经学会了。' },
          cancelled: { say: `${dish}不学了，太费时间。`, progress: '不学了。' },
          waiting: { say: '在等网购的砂锅到。', progress: '在等砂锅到货。' },
          dormant: { say: '最近没空做饭，先放着。', progress: '先放着。' },
        },
      };
    },
  },
  {
    kind: 'declutter',
    make(r, start) {
      const [thing, how] = pick(r, [['衣柜', '旧衣服捐掉'], ['书架', '看完的书卖掉'], ['阳台', '不用的花盆扔掉'],
        ['储物间', '旧家电挂到二手平台'], ['电脑硬盘', '旧文件备份后删掉']]);
      const { y, m } = monthAhead(start, 0);
      return {
        title: `${y} 年 ${m} 月整理${thing}`,
        goal: `把${thing}整理清爽。`,
        start: `${thing}太乱了，想整理一下。`,
        details: [
          { say: `${how}。`, plan: how },
          { say: '这个月内弄完。', constraint: '本月内弄完' },
        ],
        outcomes: {
          active: { say: '整理了一半。', progress: '整理了一半。' },
          done: { say: `${thing}整理完了。`, progress: '已经整理完了。' },
          cancelled: { say: '不整理了，就这样吧。', progress: '不整理了。' },
          waiting: { say: '在等回收的人上门。', progress: '在等回收上门。' },
          dormant: { say: '这事等放假再弄。', progress: '等放假再弄。' },
        },
      };
    },
  },
  {
    kind: 'digital',
    make(r, start) {
      const [task, detail] = pick(r, [['换路由器', '要能覆盖到卧室'], ['照片备份', '手机里的照片都存一份到移动硬盘'],
        ['换手机号', '先把绑定的账号都改了'], ['清理电脑', '重装一下系统'], ['换手机', '旧手机给我妈用']]);
      const { y, m } = monthAhead(start, 0);
      return {
        title: `${y} 年 ${m} 月${task}`,
        goal: `${task}。`,
        start: `打算${task}。`,
        details: [
          { say: `${detail}。`, constraint: detail },
          { say: '周末找半天时间弄。', plan: '周末找半天弄' },
        ],
        outcomes: {
          active: { say: '东西买好了，还没弄。', progress: '东西买好了，还没弄。' },
          done: { say: `${task}弄完了。`, progress: '已经弄完了。' },
          cancelled: { say: `${task}不弄了，现在这样也够用。`, progress: '不弄了。' },
          waiting: { say: '在等快递到。', progress: '在等快递。' },
          dormant: { say: '这个以后再弄。', progress: '以后再弄。' },
        },
      };
    },
  },
  {
    kind: 'certificate',
    make(r, start) {
      const cert = pick(r, ['PMP', '初级会计', '教师资格证', '普通话二甲', '游泳救生员证', '心理咨询师']);
      const { y, m } = monthAhead(start, between(r, 2, 4));
      const fee = money(r, 300, 4000, 100);
      return {
        title: `${y} 年考${cert}`,
        goal: `${y} 年考下${cert}。`,
        start: `今年想把${cert}考了。`,
        details: [
          { say: `考试在${m}月。`, plan: `${m} 月考试` },
          { say: `报名费加培训 ${fee}。`, constraint: `费用 ${fee} 元` },
          { say: '每天晚上看一小时书。', plan: '每晚看书一小时' },
        ],
        outcomes: {
          active: { say: '报上名了，在复习。', progress: '已报名，在复习。' },
          done: { say: `${cert}过了！`, progress: '已经考过了。' },
          cancelled: { say: `${cert}不考了，用处不大。`, progress: '不考了。' },
          waiting: { say: '在等报名开放。', progress: '在等报名开放。' },
          dormant: { say: '复习停了一阵。', progress: '复习停了一阵。' },
        },
      };
    },
  },
  {
    kind: 'friends',
    make(r, start) {
      const [what, where] = pick(r, [['大学同学聚会', '学校附近'], ['周末烧烤', '郊野公园'], ['朋友来家里吃饭', '家里'],
        ['公司同事聚餐', '一家湘菜馆'], ['高中同学十年聚会', '老家']]);
      const { y, m } = monthAhead(start, between(r, 0, 1));
      const people = between(r, 4, 12);
      return {
        title: `${y} 年 ${m} 月${what}`,
        goal: `${m} 月组织好${what}。`,
        start: `${m}月想搞个${what}。`,
        details: [
          { say: `大概${people}个人。`, plan: `约 ${people} 人` },
          { say: `地方定在${where}。`, plan: `在${where}` },
          { say: '人均别超过 200。', constraint: '人均 200 元以内' },
        ],
        outcomes: {
          active: { say: '人都约好了。', progress: '人约好了。' },
          done: { say: `${what}办完了，很热闹。`, progress: '已经办完了。' },
          cancelled: { say: `${what}取消了，人凑不齐。`, progress: '取消了：人凑不齐。' },
          waiting: { say: '在等大家回时间。', progress: '在等大家回时间。' },
          dormant: { say: '这事先不急。', progress: '先不急。' },
        },
      };
    },
  },
  {
    kind: 'hobby',
    make(r, start) {
      const [hobby, step] = pick(r, [['拼完那套大乐高', '每天拼一袋'], ['养一缸水草', '先买鱼缸和灯'], ['种多肉', '先买十盆'],
        ['练手冲咖啡', '先买磨豆机'], ['拼一千片的拼图', '每晚拼半小时'], ['学做皮具', '先做一个卡包']]);
      const { y, m } = monthAhead(start, 0);
      return {
        title: `${y} 年 ${m} 月${hobby}`,
        goal: `${hobby}。`,
        start: `想${hobby}。`,
        details: [
          { say: `${step}。`, plan: step },
          { say: '花销控制在 1000 以内。', constraint: '花销 1000 元以内' },
        ],
        outcomes: {
          active: { say: '已经开始了，挺上瘾的。', progress: '已经开始了。' },
          done: { say: '弄完了，很有成就感。', progress: '已经完成了。' },
          cancelled: { say: '不弄了，家里地方不够。', progress: '不弄了：地方不够。' },
          waiting: { say: '在等材料寄到。', progress: '在等材料。' },
          dormant: { say: '最近没时间，先放着。', progress: '先放着。' },
        },
      };
    },
  },
  {
    kind: 'finance',
    make(r, start) {
      const [task, detail] = pick(r, [['还清信用卡分期', '每月多还一点'], ['换一张储蓄卡', '找利率高一点的银行'],
        ['整理家里的保单', '列一张表'], ['开个养老金账户', '每年存满']]);
      const { y, m } = monthAhead(start, 0);
      const amount = money(r, 2000, 30000, 1000);
      return {
        title: `${y} 年 ${m} 月${task}`,
        goal: `${task}。`,
        start: `打算${task}。`,
        details: [
          { say: `${detail}。`, plan: detail },
          { say: `涉及的钱大概 ${amount}。`, constraint: `金额约 ${amount} 元` },
        ],
        outcomes: {
          active: { say: '在弄了。', progress: '在弄了。' },
          done: { say: `${task}搞定了。`, progress: '已经搞定了。' },
          cancelled: { say: `${task}不弄了。`, progress: '不弄了。' },
          waiting: { say: '在等银行回复。', progress: '在等银行回复。' },
          dormant: { say: '这个先放一放。', progress: '先放一放。' },
        },
      };
    },
  },
];

