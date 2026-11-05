// Long-lived matters of the background library, each with parts: steps toward it or episodes
// of it. A part is made from the date it is first mentioned, which library.mjs draws after
// its parent's. Material has the same shape as in library-kinds.mjs.
import { between, pick } from './util.mjs';
import { monthAhead } from './library-kinds.mjs';

const same = (say, progress) => ({ say, progress });

const outcomes = (subject) => ({
  active: same(`${subject}在推进。`, '在推进。'),
  done: same(`${subject}弄完了。`, '已经完成了。'),
  cancelled: same(`${subject}不弄了。`, '不弄了。'),
  waiting: same(`${subject}在等别人回复。`, '在等回复。'),
  dormant: same(`${subject}先停一停。`, '先停一停。'),
});

export const LONG = [
  {
    kind: 'weight',
    parent: () => ({
      title: '2026 年减重 10 公斤',
      goal: '2026 年底前减掉 10 公斤。',
      start: '今年想减掉 10 公斤。',
      details: [
        { say: '每天热量控制在 1800 以内。', constraint: '每天热量 1800 千卡以内' },
        { say: '膝盖不好，不跑长距离。', constraint: '膝盖不好，不跑长距离' },
        { say: '晚上八点以后不吃东西。', constraint: '晚上八点后不进食' },
      ],
      outcomes: { active: same('已经瘦了 3 公斤了。', '已经减了 3 公斤。'), dormant: same('最近应酬多，减肥停了。', '应酬多，暂停了。') },
    }),
    parts: [
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        const price = 100 * between(r, 15, 40);
        return {
          title: `${y} 年 ${m} 月办健身卡`, goal: '办一张离家近的健身卡。', start: '想办张健身卡，离家近一点的。',
          details: [{ say: `年卡 ${price} 以内。`, constraint: `年卡 ${price} 元以内` }, { say: '要有游泳池。', constraint: '要有游泳池' }],
          outcomes: { ...outcomes('健身卡'), done: same('健身卡办好了。', '已经办好了。') },
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月体脂复测`, goal: '复测一次体脂，看看进展。', start: `${m}月去复测一下体脂。`,
          details: [{ say: '还去上次那家健身房测。', plan: '在上次那家健身房测' }],
          outcomes: { ...outcomes('体脂复测'), done: same(`体脂测了，降了 ${between(r, 1, 4)} 个点。`, '已经测完了。') },
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月报游泳课`, goal: '学会自由泳。', start: '报个游泳课吧，膝盖不好跑不了步。',
          details: [{ say: `一共 ${between(r, 8, 12)} 节课。`, plan: '上一期游泳课' }, { say: '只能晚上上。', constraint: '只能晚上上课' }],
          outcomes: outcomes('游泳课'),
        };
      },
    ],
  },
  {
    kind: 'savings',
    parent: (r) => ({
      title: '2026 年理财：每月存 5000',
      goal: '2026 年每个月存下 5000 元。',
      start: '今年每个月要存 5000。',
      details: [
        { say: '不碰高风险的东西，亏了心疼。', constraint: '不买高风险产品' },
        { say: '单笔投资不超过一万。', constraint: '单笔投资不超过 1 万元' },
      ],
      outcomes: { active: same(`已经存了 ${between(r, 2, 5)} 万了。`, '在按月存。'), dormant: same('这两个月开销大，存钱停了。', '暂停了两个月。') },
    }),
    parts: [
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月开始定投指数基金`, goal: '每月定投指数基金。', start: '想每个月定投点指数基金。',
          details: [{ say: `每月投 ${500 * between(r, 2, 6)}。`, plan: '每月定投' }, { say: '每月 10 号扣款。', plan: '每月 10 号扣款' }],
          outcomes: outcomes('定投'),
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月攒应急金`, goal: '攒够六个月的生活费当应急金。', start: '得先攒一笔应急金，六个月生活费那么多。',
          details: [{ say: '放在随时能取的地方。', constraint: '随时能取出' }],
          outcomes: outcomes('应急金'),
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 1);
        return {
          title: `${y} 年 ${m} 月买储蓄国债`, goal: '买一笔储蓄国债。', start: `${m}月发国债的时候买一点。`,
          details: [{ say: '要去银行柜台抢。', plan: '去银行柜台买' }],
          outcomes: outcomes('国债'),
        };
      },
    ],
  },
  {
    kind: 'reading',
    parent: () => ({
      title: '2026 年读书计划：读完 24 本',
      goal: '2026 年读完 24 本书。',
      start: '今年想读 24 本书，一个月两本。',
      details: [{ say: '小说和非虚构一半一半。', constraint: '小说和非虚构各一半' }, { say: '尽量看纸书。', constraint: '尽量看纸书' }],
      outcomes: { active: same('已经读了 9 本了。', '已读 9 本。'), dormant: same('最近没怎么看书。', '最近没怎么读。') },
    }),
    parts: [
      (r, start) => {
        const book = pick(r, ['《百年孤独》', '《人类简史》', '《三体》', '《置身事内》', '《活着》', '《枪炮、病菌与钢铁》', '《长安的荔枝》', '《原则》']);
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月读${book}`, goal: `读完${book}。`, start: `这个月读${book}。`,
          details: [{ say: '每天睡前读半小时。', plan: '每晚睡前读半小时' }],
          outcomes: { ...outcomes(book), done: same(`${book}读完了。`, '已经读完了。') },
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月办图书馆借书证`, goal: '办一张市图书馆的借书证。', start: '去市图书馆办个借书证吧。',
          details: [{ say: '周末去，带身份证。', plan: '周末带身份证去' }],
          outcomes: outcomes('借书证'),
        };
      },
    ],
  },
  {
    kind: 'language',
    parent: () => ({
      title: '2026 年日语考到 N2',
      goal: '2026 年 12 月考过日语 N2。',
      start: '今年想把日语考到 N2。',
      details: [{ say: '每天背 30 个单词。', plan: '每天背 30 个单词' }, { say: '只用碎片时间学。', constraint: '只用碎片时间' }],
      outcomes: { active: same('N3 的语法过完了。', 'N3 语法已过完。'), dormant: same('日语停了两个月。', '停了两个月。') },
    }),
    parts: [
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月日语模考`, goal: '做一次 N2 模考，看看差多少。', start: `${m}月做一次模考。`,
          details: [{ say: '周六上午在家掐时间做。', plan: '周六上午在家计时做' }],
          outcomes: { ...outcomes('模考'), done: same(`模考做了，${between(r, 70, 110)} 分。`, '已经做完了。') },
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月报日语考试`, goal: '报上 12 月的考试。', start: '日语考试要报名了。',
          details: [{ say: '报名费 550。', constraint: '报名费 550 元' }, { say: '考点选离家近的。', constraint: '考点离家近' }],
          outcomes: outcomes('报名'),
        };
      },
    ],
  },
  {
    kind: 'home',
    parent: () => ({
      title: '2026 年家里添置和收尾',
      goal: '2026 年把新家剩下的东西添置齐。',
      start: '今年把家里剩下的东西都置办齐。',
      details: [{ say: '总预算三万，别超。', constraint: '总预算 3 万元' }, { say: '风格统一用原木色。', constraint: '统一原木色' }],
      outcomes: { active: same('添置了一大半了。', '已添置一大半。'), dormant: same('家里的事先缓缓。', '先缓一缓。') },
    }),
    parts: [
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        const item = pick(r, ['书桌', '餐边柜', '鞋柜', '窗帘', '地毯']);
        const budget = 500 * between(r, 2, 6);
        return {
          title: `${y} 年 ${m} 月买${item}`, goal: `给家里买个${item}。`, start: `家里还差个${item}。`,
          details: [{ say: `${item}要原木色的。`, constraint: '原木色' }, { say: `${item}预算 ${budget}。`, constraint: `预算 ${budget} 元` }],
          outcomes: outcomes(item),
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月装阳台灯`, goal: '阳台装一盏灯。', start: '阳台晚上太黑了，装个灯。',
          details: [{ say: '找电工来装。', plan: '找电工来装' }],
          outcomes: outcomes('阳台灯'),
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月做全屋除醛`, goal: '做一次除醛检测和治理。', start: '想找人来测一下甲醛。',
          details: [{ say: '要有检测报告的。', constraint: '要出检测报告' }],
          outcomes: outcomes('除醛'),
        };
      },
    ],
  },
  {
    kind: 'parents',
    parent: () => ({
      title: '2026 年带爸妈出去玩两次',
      goal: '2026 年带爸妈出去玩两次。',
      start: '今年要带爸妈出去玩两次。',
      details: [{ say: '每次不超过五天，他们走不动。', constraint: '每次不超过 5 天' }, { say: '不坐红眼航班。', constraint: '不坐红眼航班' }],
      outcomes: { active: same('第一次已经去过了。', '第一次已去过。'), dormant: same('爸妈最近身体不太好，先不出去了。', '暂停：爸妈身体不太好。') },
    }),
    parts: [
      (r, start) => {
        const city = pick(r, ['杭州', '黄山', '青岛', '厦门', '桂林']);
        const { y, m } = monthAhead(start, 1);
        return {
          title: `${y} 年 ${m} 月带爸妈去${city}`, goal: `${m} 月带爸妈去${city}。`, start: `${m}月带爸妈去${city}转转。`,
          details: [{ say: '住的地方要有电梯。', constraint: '住处要有电梯' }, { say: '坐高铁去。', plan: '坐高铁去' }],
          outcomes: outcomes(`${city}那趟`),
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 2);
        return {
          title: `${y} 年 ${m} 月带爸妈泡温泉`, goal: '带爸妈去泡一次温泉。', start: '找个周末带爸妈去泡温泉。',
          details: [{ say: '开车去，别太远。', plan: '自驾' }],
          outcomes: outcomes('泡温泉'),
        };
      },
    ],
  },
  {
    kind: 'running',
    parent: () => ({
      title: '2026 年跑一次半程马拉松',
      goal: '2026 年完赛一次半马。',
      start: '今年想跑一次半马。',
      details: [{ say: '目标两个半小时以内。', constraint: '两个半小时以内完赛' }, { say: '每周跑三次。', plan: '每周跑三次' }],
      outcomes: { active: same('已经能跑 15 公里了。', '能跑 15 公里了。'), dormant: same('脚踝扭了，先停跑。', '脚踝扭伤，暂停。') },
    }),
    parts: [
      (r, start) => {
        const { y, m } = monthAhead(start, 2);
        const city = pick(r, ['厦门', '无锡', '兰州', '扬州']);
        return {
          title: `${y} 年 ${m} 月报名${city}半马`, goal: `报上${city}的半马。`, start: `想报${city}的半马。`,
          details: [{ say: '要抽签，不一定中。', constraint: '要抽签' }],
          outcomes: outcomes('报名'),
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月买跑鞋`, goal: '买一双缓震好的跑鞋。', start: '跑鞋该换了。',
          details: [{ say: `一千以内。`, constraint: '1000 元以内' }],
          outcomes: outcomes('跑鞋'),
        };
      },
    ],
  },
  {
    kind: 'photo',
    parent: () => ({
      title: '2026 年攒一组街拍作品集',
      goal: '2026 年攒够 30 张满意的街拍。',
      start: '今年想攒一组街拍作品集。',
      details: [{ say: '只用定焦镜头拍。', constraint: '只用定焦镜头' }, { say: '每月出去扫街两次。', plan: '每月扫街两次' }],
      outcomes: { active: same('已经有 12 张满意的了。', '已有 12 张满意的。'), dormant: same('最近没出去拍。', '最近没拍。') },
    }),
    parts: [
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        const city = pick(r, ['香港', '宁波', '广州', '上海']);
        return {
          title: `${y} 年 ${m} 月去${city}扫街`, goal: `去${city}拍一天街拍。`, start: `${m}月想去${city}扫一天街。`,
          details: [{ say: '当天来回。', plan: '当天往返' }],
          outcomes: outcomes(`${city}扫街`),
        };
      },
      (r, start) => {
        const { y, m } = monthAhead(start, 0);
        return {
          title: `${y} 年 ${m} 月洗一批照片`, goal: '把满意的照片洗出来。', start: '想把满意的几张洗出来挂墙上。',
          details: [{ say: '洗 A4 大小的。', plan: '洗 A4 尺寸' }],
          outcomes: outcomes('洗照片'),
        };
      },
    ],
  },
];
