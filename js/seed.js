/* SAMPLE DATA — 示例店铺 / နမူနာဆိုင်များ / Sample shops
 * Clearly marked sample:true. Delete or replace with real shops anytime.
 * 这些是示例数据，可随时删除或替换为真实店铺。
 * Menu items may carry a `photoUrl` field with a real uploaded food photo URL.
 * (PLACEHOLDER: while photoUrl is empty, the app renders a decorative
 *  gradient + emoji placeholder — see dishPhotoHTML in js/app.js.)
 *
 * Categories (final approved design — keep these ids stable):
 *   all=全部/အားလုံး/All · foods=美食/အစားအစာ/Foods · fruits=水果/သစ်သီး/Fruits
 *   rice=盖饭/ထမင်းဟင်း/Rice meals · cakes=蛋糕/ကိတ်မုန့်/Cakes
 *   icecream=冰淇淋/ရေခဲမုန့်/Ice cream
 */
const SAMPLE_SHOPS = [
  {
    id: "sample-noodle",
    name_zh: "老滇味小吃", name_my: "ရှမ်းအစားအစာဆိုင်ဟောင်း", name_en: "Old Dian Snacks",
    ownerName: "李老板", address_zh: "勐拉中心街88号", address_my: "မိုင်းလား စင်တာလမ်း ၈၈",
    phone: "+86 13800000001", category: "foods", emoji: "🍜", sample: true,
    menu: [
      { name_zh: "过桥米线", name_my: "ကျော်ဖြတ်ခေါက်ဆွဲ", name_en: "Crossing-bridge noodles", price: 15, category: "foods", emoji: "🍜" },
      { name_zh: "小锅米线", name_my: "အိုးသေးခေါက်ဆွဲ", name_en: "Small-pot noodles", price: 12, category: "foods", emoji: "🍜" },
      { name_zh: "烤鸡翅", name_my: "ကြက်တောင်ပံကင်", name_en: "Grilled chicken wings", price: 8, category: "foods", emoji: "🍢" }
    ]
  },
  {
    id: "sample-fruit",
    name_zh: "鲜果时光", name_my: "လတ်ဆတ်သစ်သီးဆိုင်", name_en: "Fresh Fruit Time",
    ownerName: "王老板", address_zh: "勐拉友谊路12号", address_my: "မိုင်းလား ချစ်ကြည်ရေးလမ်း ၁၂",
    phone: "+86 13800000002", category: "fruits", emoji: "🍎", sample: true,
    menu: [
      { name_zh: "芒果", name_my: "သရက်သီး", name_en: "Mango", price: 10, category: "fruits", emoji: "🥭" },
      { name_zh: "西瓜", name_my: "ဖရဲသီး", name_en: "Watermelon", price: 8, category: "fruits", emoji: "🍉" },
      { name_zh: "香蕉", name_my: "ငှက်ပျောသီး", name_en: "Banana", price: 5, category: "fruits", emoji: "🍌" }
    ]
  },
  {
    id: "sample-rice",
    name_zh: "缅式饭店", name_my: "မြန်မာထမင်းဟင်းဆိုင်", name_en: "Myanmar Rice House",
    ownerName: "U Aung", address_zh: "勐拉曼仰路3号", address_my: "မိုင်းလား မန်ယန်းလမ်း ၃",
    phone: "+86 13800000003", category: "rice", emoji: "🍚", sample: true,
    menu: [
      { name_zh: "鸡腿饭", name_my: "ကြက်ပေါင်ထမင်း", name_en: "Chicken leg rice", price: 18, category: "rice", emoji: "🍗" },
      { name_zh: "排骨饭", name_my: "နံရိုးထမင်း", name_en: "Pork ribs rice", price: 20, category: "rice", emoji: "🍖" },
      { name_zh: "炒饭", name_my: "ထမင်းကြော်", name_en: "Fried rice", price: 12, category: "rice", emoji: "🍚" }
    ]
  },
  {
    id: "sample-cake",
    name_zh: "甜蜜蛋糕屋", name_my: "ကိတ်မုန့်ဆိုင်", name_en: "Sweet Cake House",
    ownerName: "陈老板", address_zh: "勐拉中心街101号", address_my: "မိုင်းလား စင်တာလမ်း ၁၀၁",
    phone: "+86 13800000004", category: "cakes", emoji: "🍰", sample: true,
    menu: [
      { name_zh: "巧克力蛋糕", name_my: "ချောကလက်ကိတ်", name_en: "Chocolate cake", price: 25, category: "cakes", emoji: "🍫" },
      { name_zh: "奶油蛋糕", name_my: "ခရင်မ်ကိတ်", name_en: "Cream cake", price: 22, category: "cakes", emoji: "🍰" },
      { name_zh: "面包", name_my: "ပေါင်မုန့်", name_en: "Bread", price: 6, category: "cakes", emoji: "🍞" }
    ]
  },
  {
    id: "sample-icecream",
    name_zh: "冰爽一夏", name_my: "ရေခဲမုန့်ဆိုင်", name_en: "Ice Cool Summer",
    ownerName: "张老板", address_zh: "勐拉夜市A区5号", address_my: "မိုင်းလား ညဈေး A ခန်း ၅",
    phone: "+86 13800000005", category: "icecream", emoji: "🍨", sample: true,
    menu: [
      { name_zh: "巧克力冰淇淋", name_my: "ချောကလက်ရေခဲမုန့်", name_en: "Chocolate ice cream", price: 9, category: "icecream", emoji: "🍦" },
      { name_zh: "香草冰淇淋", name_my: "ဗနီလာရေခဲမုန့်", name_en: "Vanilla ice cream", price: 9, category: "icecream", emoji: "🍨" },
      { name_zh: "芒果沙冰", name_my: "သရက်သီးရေခဲ", name_en: "Mango shaved ice", price: 12, category: "icecream", emoji: "🍧" }
    ]
  }
];

/* Final approved category bar (left → right). "all" is default & first. */
const CATEGORIES = [
  { id: "all",      zh: "全部",   my: "အားလုံး",     en: "All" },
  { id: "foods",    zh: "美食",   my: "အစားအစာ",     en: "Foods" },
  { id: "fruits",   zh: "水果",   my: "သစ်သီး",       en: "Fruits" },
  { id: "rice",     zh: "盖饭",   my: "ထမင်းဟင်း",     en: "Rice meals" },
  { id: "cakes",    zh: "蛋糕",   my: "ကိတ်မုန့်",     en: "Cakes" },
  { id: "icecream", zh: "冰淇淋", my: "ရေခဲမုန့်",     en: "Ice cream" }
];
function catName(id) {
  const c = CATEGORIES.find(x => x.id === id);
  if (!c) return id;
  if (LANG === "en") return c.en;
  if (LANG === "my") return c.my;
  return c.zh;
}
