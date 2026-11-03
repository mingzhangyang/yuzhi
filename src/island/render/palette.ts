/**
 * 小岛画布调色板（美术优化计划 A1 / A2）。
 *
 * 画布上的每一个颜色都从这里取，绘制代码里不再写十六进制或 rgba 字面量（tests/palette.test.ts 会检查）。
 * 分三层：
 *   1. BOARD：方向板（docs/art/art-direction-board.webp）的 10 个基础色。
 *   2. 材质与物件族：目前画面实际使用的颜色，按材质（木、石、灰泥、玻璃……）和物件归组，
 *      每一族注明它属于方向板的哪个基础色。A2 只把字面量搬到这里、数值一个不改，截图逐像素一致；
 *      B / C 期调色时改这里的数值（或改成从 BOARD 派生），绘制代码不用动。
 *   3. 派生函数：季节、积雪、衰败、透明度都通过同一组纯函数计算。
 *
 * 地图景物的标记色 MARKER（图例、追踪栏色块共用）不在这里，仍在 style.ts，保持独立。
 */
import { clamp, mix, shade } from './utils';

/* ================================================================
 * 1. 方向板的 10 个基础色
 * ================================================================ */

/**
 * 从方向板取样（色块中心 15×15 像素的中位数）。色块带水彩纹理，数值需要人工校准后再定稿；
 * 校准前不要直接拿来替换下面各族的颜色。
 */
export const BOARD = {
  /** 海水蓝：浅水、河 */
  sea: '#92cbd0',
  /** 深海蓝：远海、夜晚的海 */
  seaDeep: '#356181',
  /** 春草绿：春季草地基色 */
  springGrass: '#92a55f',
  /** 夏日绿：夏季林地、深色草 */
  summerGreen: '#567d68',
  /** 秋麦黄：农田、秋季 */
  wheat: '#ebb664',
  /** 岩石灰：崖壁、礁石、山 */
  rock: '#a69a91',
  /** 温润木：码头、木构 */
  wood: '#9c6b42',
  /** 灯火金：窗灯、灯塔、落成 */
  lamp: '#f8cd79',
  /** 暮色橙：黄昏光 */
  dusk: '#e88e50',
  /** 雪色白：积雪基色（阴影另配冷色） */
  snow: '#dedcdd',
} as const;

export type BoardColor = keyof typeof BOARD;

/* ================================================================
 * 2. 材质与物件族（数值即当前画面，A2 不调色）
 * ================================================================ */

/** 纯白：浪花、波光、白沫、雪点的底色，配合 withAlpha 使用 */
export const WHITE = '#ffffff';

/** 积雪（雪色白）：受光面与背光面 */
export const SNOW = '#f3f6f8';
export const SNOW_SHADE = '#d6e0e8';
/** 沙滩（秋麦黄族，偏浅） */
export const BEACH = '#e9d9ae';

/** 落地阴影的墨色（rgb 30,40,20），透明度由调用方给 */
export const SHADOW_INK = '#1e2814';

/** 各季的 [季初, 季末] 两个色，按季节进度插值；冬季只有一个色 */
type SeasonStops = readonly (readonly [string, string?])[];

/** 地面（春草绿 / 夏日绿 / 秋麦黄族）：各季草地、田地的起止色（seasonGrass / seasonField） */
export const GROUND = {
  grass: [['#b6d27c', '#9cc464'], ['#8fb855', '#86ad4f'], ['#b3b65f', '#c7a85a'], ['#b2ad88']] as SeasonStops,
  field: [['#b9cf7a', '#9fc35e'], ['#c2c45a', '#dcbc4c'], ['#e3ad45', '#c7a26c'], ['#b5a382']] as SeasonStops,
  /** 小溪：平时、冬季、结冰 */
  water: '#7db3c7',
  waterWinter: '#9cc4d2',
  waterFrozen: '#cfe2ea',
  /** 小溪露在崖边的左右两面 */
  waterFaceLeft: '#5f93a8',
  waterFaceRight: '#4f8197',
  mountain: '#a3a68f',
  plaza: '#e4d8b8',
  sand: '#e6d6a8',
  /** 村内小路：混进当季草色 */
  path: '#d9c79c',
  /** 湿沙上的白点、沙地上的贝壳 */
  foamDot: '#f6efe2',
  shell: '#f4ead8',
} as const;

/** 岩石（岩石灰族）：崖壁、礁石、山体 */
export const ROCK = {
  cliff: '#a39b8b',
  /** 礁石受光面、积雪时的受光面、背光面、顶上的高光 */
  stone: '#8f887b',
  stoneSnowy: '#9b968c',
  stoneShade: '#6f695f',
  stoneTop: '#a9a294',
  /** 山的岩块：受光面、背光面、岩层缝 */
  massLit: '#aaa496',
  massShade: '#7c776c',
  seam: '#3c3a32',
  /** 背光一侧的挂雪 */
  snowShade: '#dcdcd2',
  /** 山脚草坡：秃（冬、秋）与绿（春夏）之间插值 */
  footBare: '#8d927c',
  footGreen: '#7fa25a',
} as const;

/** 树木（夏日绿族）：松、阔叶、樱花、秋叶、果子 */
export const TREE = {
  trunk: '#6e5034',
  pine: ['#55874a', '#45743f', '#45743f', '#4f6f4f'],
  round: ['#86b54e', '#5c8f3c'],
  cherryBloom: '#f2b8c8',
  cherryLeaf: '#a8cf78',
  petal: '#fff1f5',
  /** 秋叶：从黄绿过渡到下面四种之一 */
  autumnBase: '#a7a43c',
  autumn: ['#d99a2b', '#c8642c', '#b84a2e', '#d6b23a'],
  /** 枝头最后几片叶子 */
  lastLeaves: ['#c4532e', '#d9782a'],
  fruit: '#d9483a',
} as const;

/** 草地上的小花、落叶（tileDetail） */
export const MEADOW = {
  spring: ['#f7c6d4', '#ffffff', '#f6dc6b', '#c9b3f0'],
  summer: ['#f6dc6b', '#ffffff'],
  fallen: ['#d9782a', '#c4532e', '#e2b13c', '#a8432a'],
  snowDot: '#ffffff',
} as const;

/** 大田里的庄稼（秋麦黄族）：春苗、夏禾、熟穗、茬，收割后的草垛 */
export const CROP = {
  spring: '#6f9c3f',
  summer: '#5f8f34',
  ripe: '#d8a332',
  stubble: '#a88a5a',
  hay: '#d8b25a',
  hayShade: '#b8913f',
} as const;

/** 飘落物（simulation.spawnDrift）：春天的花瓣、秋天早晚两批落叶 */
export const DRIFT = {
  petal: ['#f6c1cf', '#fbe3ea'],
  leafEarly: ['#e2b13c', '#d98a2b', '#c9a23a'],
  leafLate: ['#c4532e', '#d9782a', '#a8432a', '#e0a33a'],
} as const;

/** 木（温润木族）：通用的木构件 */
export const WOOD = {
  /** 深色木：旗杆、窗框外、桅杆、井架、告示牌腿、枝条 */
  dark: '#6b4a30',
  /** 横梁、系缆桩帽 */
  beam: '#6e4d32',
  /** 窗框 */
  frame: '#7b5e45',
  /** 栏杆：侧面、背光面、顶面 */
  rail: '#8a6242',
  railTop: '#9c7350',
  deck: '#a77b52',
  /** 系缆桩、灯笼挂钩 */
  post: '#5a4030',
  /** 灯笼的细绳 */
  string: '#5a3a24',
} as const;

/** 石（岩石灰族偏暖）：屋基、台阶、石台 */
export const STONE = {
  footing: '#b9ad97',
  footingShade: '#9c917d',
  /** 台阶：左面、右面、顶面 */
  step: '#d6ccb6',
  stepShade: '#bfb49c',
  stepTop: '#e4dac4',
  /** 矮基座：左面、右面 */
  base: '#cfc6b0',
  baseShade: '#b5ab94',
  /** 砌缝（rgb 120,105,80） */
  seam: '#786950',
} as const;

/** 灰泥墙（雪色白族偏暖）：民居、塔楼的墙面 */
export const PLASTER = {
  wall: '#efe5cf',
  /** 蒙灰、封窗后的墙 */
  wallDusty: '#e6dcc6',
  wallBoarded: '#cfc4ab',
  /** 杂务小屋 */
  chores: '#e3dccb',
  /** 钟楼、纪念塔：受光面、背光面 */
  tower: '#efe6d2',
  towerShade: '#d3c8b1',
} as const;

/** 窗（灯火金族）：夜里点灯、白天的玻璃、封窗 */
export const GLASS = {
  lit: '#ffd677',
  day: '#8fa5b2',
  boarded: '#5a4a3a',
  /** 封窗的木条 */
  boards: '#3d3128',
} as const;

/** 灯（灯火金族）：灯头的亮 / 灭、发光 */
export const LAMP = {
  on: '#ffe08a',
  off: '#e8e2cc',
  /** 道具贴图上的灯（rgb 255,224,138） */
  propOn: '#ffe08a',
  /** 灯杆、回廊这类深色铁件 */
  iron: '#3e3a36',
} as const;

/**
 * 发光（lights 的 rgb 三元组，drawLights 以叠加方式画出光晕）。
 * 不受环境光调色影响，保持是画面里最亮的东西。
 */
export const GLOW = {
  warm: '255,206,110',
  lantern: '255,120,70',
  beacon: '255,236,160',
  fire: '255,170,90',
  firefly: '200,255,120',
  skyLantern: '255,170,80',
  festive: '255,140,140',
  /** 村里聚会的地面光圈（白天） */
  gathering: '210,174,98',
} as const;

/** 节日装饰 */
export const FESTIVE = {
  /** 对联、门上花环的红果、圣诞帽 */
  red: '#d63a2c',
  lantern: '#e0372b',
  /** 中秋灯笼 */
  mooncake: '#f29a3a',
  lanternBand: '#f2c14a',
  /** 国庆的旗与星 */
  flag: '#de2910',
  star: '#ffd84a',
  wreath: '#3f7a3a',
  /** 圣诞彩灯：红、黄、蓝、绿；灭的时候 */
  bulbs: ['#ff5a5a', '#ffd84a', '#5ab4ff', '#7cff7a'],
  bulbOff: '#5a4a3a',
  /** 孔明灯 */
  skyLantern: '#ffb35a',
  /** 端午龙舟：船身、金边、龙头与龙尾、龙眼、划手的衣服、肤色、桨 */
  boatHull: '#c8473a',
  boatTrim: '#e2ad2f',
  dragon: '#2f7a4a',
  dragonEye: '#ffd84a',
  rowers: ['#c8473a', '#e0b84a', '#4c6a84'],
  rowerSkin: '#e6b48c',
  oar: '#6b4a30',
} as const;

/** 小人：腿、冬天的围巾和毛线帽、夏天的草帽、包袱、伞 */
export const FIGURE = {
  skin: ['#f1c9a5', '#e6b48c', '#d9a074', '#c98d62'],
  hair: ['#2f2620', '#4a3426', '#1f1c1a', '#6b4a2e', '#3b2f2a'],
  legs: '#4a4038',
  scarf: ['#c8473a', '#e0b84a'],
  hat: ['#e7e2d6', '#5a7f95'],
  pompom: '#ffffff',
  straw: '#e6c878',
  strawShade: '#d6b45e',
  hatBand: '#c8473a',
  bundle: '#b98b3c',
  bundleStrap: '#8a6428',
  umbrella: ['#d8574a', '#4c6a84', '#e0b84a', '#5d8a4a'],
} as const;

/** 民居：门、门把手、烟囱、炊烟（rgb 236,236,232），蒙灰时屋顶混进的灰 */
export const HOUSE = {
  doorFrame: '#5e4532',
  doorPanel: '#7a5a40',
  knob: '#e2c56a',
  leanToDoor: '#6a4e38',
  chimney: '#a0796a',
  chimneyShade: '#80594c',
  smoke: '#ecece8',
  roofDust: '#9a9588',
} as const;

/** 村中央的井 */
export const WELL = {
  body: '#8f8a7a',
  rim: '#a7a290',
  water: '#5a7f95',
  /** 蒙灰以后井水发灰 */
  waterStale: '#7d8a8c',
  waterFrozen: '#cfe2ea',
  frame: '#6b4a30',
} as const;

/** 杂草：平时、冬天 */
export const WEEDS = {
  grow: '#6d7f3a',
  winter: '#8a835f',
} as const;

/** 粮仓（秋麦黄 + 温润木）：木板仓身渐变、存量、铁箍、尖顶、门 */
export const GRANARY = {
  body: ['#f2e6c8', '#dccaa0', '#b9a47a'],
  /** 木板缝（rgb 120,90,50） */
  plank: '#785a32',
  grain: '#e2ad2f',
  grainLow: '#c98a4a',
  hoop: '#6b5a44',
  cap: '#9c6a35',
  roof: '#b07a40',
  roofShade: '#8a5a2c',
  door: '#6e4d32',
  doorway: '#3f3025',
} as const;

/** 日程：告示牌、聚会、落下来的砖、条幅 */
export const AGENDA = {
  boardSoon: '#c98a3b',
  board: '#8a6e4d',
  boardPaper: '#f4e2b7',
  boardCount: '#fff6dc',
  boardLegs: '#6b4a30',
  gatheringDot: '#d9b45f',
  gatheringDotLit: '#ffe08a',
  brick: '#d8c5a6',
  brickEdge: '#a88768',
  bannerPole: '#72533b',
  bannerText: '#fff4d8',
  /** 灯塔条幅的布色 */
  lighthouseBanner: '#d8c9a7',
} as const;

/** 杂务小屋旁：柴堆（深浅两色）、扫帚 */
export const CHORES_YARD = {
  logs: ['#a87546', '#875a35'],
  broomHandle: '#725033',
  broomHead: '#c49b55',
} as const;

/** 漂流瓶 */
export const BOTTLE = {
  glass: '#d4a45e',
  edge: '#8a633a',
  cork: '#f4dfaa',
  number: '#fff2c5',
} as const;

/** 码头的船：船身、木板缝（rgb 60,35,20）、桅杆、三色帆、两色小旗 */
export const BOAT = {
  hull: '#7a4e2c',
  hullTop: '#a8713f',
  seam: '#3c2314',
  mast: '#6b4a30',
  sails: ['#f4efe2', '#efe0c4', '#f7f3ea'],
  pennants: ['#4c6a84', '#c8473a'],
} as const;

/** 码头栈桥：桩、梁、木板缝（rgb 80,50,30） */
export const PIER = {
  pile: '#4e3522',
  beam: '#6b4a30',
  seam: '#50321e',
} as const;

/** 灯塔：白塔两面、红环两面、门、回廊、灯室、塔顶 */
export const LIGHTHOUSE = {
  tower: '#f4f1e8',
  towerShade: '#d6d2c6',
  band: '#c8473a',
  bandShade: '#a0372d',
  door: '#6b4a30',
  gallery: '#3e3a36',
  lampOn: '#fff0a8',
  lampOff: '#cfe3e8',
  cap: '#9a3a30',
  /** 光柱（rgb 255,232,150） */
  beam: '#ffe896',
} as const;

/** 地标的石台：两侧、顶面、砌缝（rgb 90,80,60） */
export const PLINTH = {
  side: '#cfc8b4',
  sideShade: '#b3ab95',
  top: '#e4dece',
  seam: '#5a503c',
} as const;

/** 共用的地标细件：旗杆、铜饰、宝顶 */
export const LANDMARK = {
  flagPole: '#6b4a30',
  brass: '#c99a3c',
  finial: '#e2b84a',
  /** 风车门、观星台门这类深木门 */
  door: '#6a4e38',
} as const;

/** 钟楼 */
export const CLOCK = {
  slitOff: '#6f7f88',
  faceRim: '#5a4a3a',
  face: '#f8f3e6',
  faceLit: '#fff1c8',
  hands: '#3d3128',
  belfry: '#4a3c30',
  belfryShade: '#3a2f26',
  column: '#e8dcc4',
} as const;

/** 藏书阁：墙两面、红柱 */
export const LIBRARY = {
  wall: '#f1e4c8',
  wallShade: '#d7c7a6',
  pillar: '#8a3b2a',
} as const;

/** 风车：塔身渐变、帆布（平时 / 积雪）、帆架、帆格线（rgb 107,74,48）、轴心 */
export const WINDMILL = {
  body: ['#f3ead6', '#e0d3b6', '#bfb092'],
  sail: '#f1e8d4',
  sailSnowy: '#eef1f3',
  spar: '#6b4a30',
  sailLine: '#6b4a30',
  hub: '#4a3a2c',
} as const;

/** 观星台：塔身渐变、平台、金属穹顶渐变与接缝（rgb 50,60,70）、观测缝、望远镜 */
export const OBSERVATORY = {
  body: ['#f1e7d2', '#dccfb2', '#b9ab8e'],
  dome: ['#c4ccd4', '#98a4b0', '#6c7886'],
  domeSeam: '#323c46',
  slitLit: '#ffd98a',
  slit: '#2f3842',
  tube: '#8a6328',
  tubeTrim: '#c99a4a',
  lens: '#5a4126',
} as const;

/**
 * 玻璃温室：铁框，各季的绿植与花，玻璃（白天偏青、夜里透灯光，各带透明度）。
 * 玻璃的 rgba 原样保留，绘制时直接用。
 */
export const GREENHOUSE = {
  frame: '#4f6b5a',
  leaf: ['#6fae55', '#5f9a48', '#8a9a48', '#5f8a5a'],
  leafSnowy: '#6f8f6a',
  bloom: ['#f2a6c0', '#f6d36b', '#e88a5a', '#e9e4f2'],
  backLit: ['rgba(236,214,150,.85)', 'rgba(217,197,138,.85)'],
  back: ['rgba(170,205,198,.9)', 'rgba(156,189,182,.9)'],
  frontLit: ['rgba(255,226,150,.5)', 'rgba(240,212,141,.5)'],
  front: ['rgba(214,238,232,.5)', 'rgba(201,224,218,.5)'],
  roofLit: ['rgba(255,230,165,.7)', 'rgba(240,210,140,.7)'],
  roof: ['rgba(226,244,240,.75)', 'rgba(196,224,220,.75)'],
  cupola: ['rgba(226,244,240,.9)', 'rgba(196,224,220,.9)'],
} as const;

/** 海港会馆：石基、墙、山墙、锚、烟囱、系缆桩上的绳、门 */
export const HARBOR_HALL = {
  footing: '#bfb7a3',
  footingShade: '#a59c87',
  wall: '#efe2c6',
  wallShade: '#d3c3a2',
  gable: '#e6d7b8',
  anchor: '#3e4c5c',
  chimney: '#9a8d78',
  chimneyShade: '#7f735f',
  rope: '#c8ab72',
  door: '#5a3f2c',
} as const;

/** 纪念塔：上层台阶、碑、压顶石、铜盆、火焰 */
export const MEMORIAL = {
  upperStep: '#ddd3bd',
  upperStepShade: '#c4b9a1',
  upperStepTop: '#e9dfc9',
  tablet: '#a69a82',
  capShade: '#c9bea6',
  capTop: '#f0e8d6',
  brazier: '#7a5a2c',
  brazierRim: '#9c7a3c',
  flame: '#f08a3a',
  flameCore: '#ffd36b',
} as const;

/** 山亭：红柱、矮栏、石桌石凳、亭基顶面、花树（春 / 夏 / 秋）、檐下灯笼 */
export const PAVILION = {
  pillar: '#9a3a2c',
  rail: '#7a3428',
  tableLeg: '#a79f8c',
  table: '#c9c1ad',
  stool: '#b8b09c',
  baseTop: '#e0d8c4',
  crown: ['#f3b6c8', '#6fae55', '#e0904a'],
  lanternLit: '#ffb070',
  lantern: '#c8473a',
} as const;

/** 培育区（cultivation.ts）：每一区平时与积雪两套 */
export const CULTIVATION = {
  field: {
    soil: '#9d7244',
    soilSnow: '#d9d4c6',
    edge: '#72543b',
    furrow: '#715037',
    furrowSnow: '#aaa79d',
    stalk: '#4f7c3d',
    stalkRipe: '#81762f',
    stalkSnow: '#7f8274',
    stalkRipeSnow: '#9a8756',
    ear: '#78a84f',
    earRipe: '#d3ab4b',
    earSnow: '#a8ad98',
    earRipeSnow: '#c4aa73',
  },
  orchard: {
    grass: '#8ead62',
    grassSnow: '#d8d5c8',
    edge: '#668048',
    trunk: '#6f5035',
    crown: '#4f833f',
    crownBare: '#9b8f72',
    blossom: '#f0d8cf',
    fruit: '#c95a3b',
  },
  pond: {
    water: '#6aaeb6',
    ice: '#cbd8dc',
    bank: '#4c7e79',
    /** 涟漪：水面上是白的（rgb 255,255,255），冰面上是灰蓝的裂纹（rgb 91,118,126） */
    ripple: '#ffffff',
    crack: '#5b767e',
    reed: '#557f48',
    reedSnow: '#768071',
    fish: '#355f69',
    fishIce: '#6d8790',
  },
  garden: {
    grass: '#8eb470',
    grassSnow: '#ddd7ca',
    edge: '#66814e',
    stem: '#557e45',
    petals: ['#d65b79', '#e6ad45', '#8659a6', '#f2e7ca'],
    heart: '#d8a947',
  },
} as const;

/** 天空与光：云影、鸟、雨丝、月亮、星光、萤火、烟花闪光、黄昏暖光 */
export const SKY = {
  /** 云影（rgb 20,30,40） */
  cloudShadow: '#141e28',
  /** 鸟（rgb 60,60,60） */
  bird: '#3c3c3c',
  /** 雨丝（rgb 220,232,245） */
  rain: '#dce8f5',
  /** 月晕（rgb 230,236,255）、水面月光（rgb 240,240,220）、月盘、暗面（rgb 200,210,230）、环形山（rgb 200,196,170） */
  moonHalo: '#e6ecff',
  moonGlint: '#f0f0dc',
  moon: '#fbf6e0',
  moonDark: '#c8d2e6',
  moonCrater: '#c8c4aa',
  /** 水面星光（rgb 255,255,240） */
  starGlint: '#fffff0',
  /** 烟花炸开的闪光（rgb 255,240,200） */
  flash: '#fff0c8',
  /** 日出日落的暖光（rgb 255,170,90） */
  duskGlow: '#ffaa5a',
  firework: ['#ffd36b', '#ff7a6b', '#8fd3ff', '#c99bff', '#9dff9b', '#ffffff', '#ffb3d9'],
} as const;

/** 转场与提示：阶段变差落灰、变好散灰、钟声、落砖光圈、海雾 */
export const CUE = {
  /** 阶段变差（rgb 130,130,115）、变好（rgb 225,235,205） */
  decline: '#828273',
  recover: '#e1ebcd',
  /** 日程钟声的涟漪（rgb 238,205,112） */
  bell: '#eecd70',
  /** 落砖光圈（rgb 226,173,47） */
  pulse: '#e2ad2f',
  /** 海雾团（rgb 236,240,240）与整片薄雾（rgb 230,234,235） */
  fog: '#ecf0f0',
  fogVeil: '#e6eaeb',
} as const;

/** 画布标签（E2 期再调）：投影墨色（rgb 20,30,20）、夜里压暗混进的蓝灰 */
export const LABEL = {
  shadow: '#141e14',
  night: '#4a5068',
} as const;

/* ================================================================
 * 3. 派生函数
 * ================================================================ */

const rgbCache = new Map<string, string>();

/** 十六进制颜色的 "r,g,b"，给需要动态透明度的 rgba() 用 */
export function rgbOf(hex: string): string {
  let out = rgbCache.get(hex);
  if (out === undefined) {
    let h = hex.trim();
    if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    out = `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`;
    rgbCache.set(hex, out);
  }
  return out;
}

/** 调色板颜色加透明度 */
export function withAlpha(hex: string, alpha: number): string {
  return `rgba(${rgbOf(hex)},${alpha})`;
}

/** 当季的草地底色：季初到季末按进度 p（0–1）插值；冬季不随进度变化 */
export function seasonGrass(season: number, p: number): string {
  const [from, to] = GROUND.grass[season];
  return to === undefined ? from : mix(from, to, p);
}

/** 当季的田地底色 */
export function seasonField(season: number, p: number): string {
  const [from, to] = GROUND.field[season];
  return to === undefined ? from : mix(from, to, p);
}

/**
 * 地块被雪覆盖后的颜色：积雪厚度 cover（0–1）乘上地块自己的起伏 n（0–1，低频噪声），
 * 最多盖住 92%，留一点底色。cover 为 0 时原样返回。
 */
export function snowBlend(col: string, cover: number, n: number): string {
  if (cover <= 0) return col;
  return mix(col, SNOW, clamp(cover * (0.86 + 0.18 * n), 0, 0.92));
}

/** 衰败阶段 0–3 时屋顶混进的灰（正常 / 安静 / 蒙灰 / 搬离） */
export const DECAY_DUST = [0, 0.1, 0.45, 0.6] as const;

/** 村里一户的屋顶色：村色按户的随机数 v（0–1）略作深浅，再按阶段混灰 */
export function decayRoof(roof: string, stage: number, v: number): string {
  return mix(shade(roof, (v - 0.5) * 0.25), HOUSE.roofDust, DECAY_DUST[stage] ?? 0);
}

/** 村里一户的墙色：封窗的最暗，蒙灰以后褪色 */
export function decayWall(stage: number, boarded: boolean): string {
  return boarded ? PLASTER.wallBoarded : stage >= 2 ? PLASTER.wallDusty : PLASTER.wall;
}
