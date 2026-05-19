export type AirportCatalogItem = {
  code: string;
  text: string;
  aliases: string[];
};

/**
 * Canonical airport catalog used by parser and mapper boundaries.
 *
 * Keep airport code/text updates here so resolver logic stays small and future
 * airport additions do not touch Telegram or Playwright automation flows.
 */
export const AIRPORT_CATALOG = [
  {
    code: 'VCA',
    text: 'Can Tho International Airport (VCA)',
    aliases: ['vca', 'can tho', 'cantho', 'tra noc', 'tra noc airport'],
  },
  {
    code: 'DLI',
    text: 'Lien Khuong International Airport (DLI)',
    aliases: ['dli', 'da lat', 'dalat', 'lien khuong', 'lam dong'],
  },
  {
    code: 'DAD',
    text: 'Da Nang International Airport (DAD)',
    aliases: ['dad', 'da nang', 'danang'],
  },
  {
    code: 'HPH',
    text: 'Cat Bi International Airport (HPH)',
    aliases: ['hph', 'hai phong', 'haiphong', 'cat bi'],
  },
  {
    code: 'VDO',
    text: 'Van Don International Airport (VDO)',
    aliases: ['vdo', 'van don', 'quang ninh'],
  },
  {
    code: 'HAN',
    text: 'Sân bay Nội Bài (HAN)',
    aliases: ['ha noi', 'hanoi', 'noi bai', 'han'],
  },
  {
    code: 'SGN',
    text: 'Sân bay Tân Sơn Nhất (SGN)',
    aliases: ['sai gon', 'saigon', 'ho chi minh', 'tphcm', 'sgn', 'tan son nhat'],
  },
  {
    code: 'HUI',
    text: 'Phu Bai International Airport (HUI)',
    aliases: ['hui', 'hue', 'phu bai', 'thua thien hue'],
  },
  {
    code: 'CXR',
    text: 'Cam Ranh International Airport (CXR)',
    aliases: ['cxr', 'nha trang', 'cam ranh', 'cam ranh air base'],
  },
  {
    code: 'PQC',
    text: 'Phu Quoc International Airport (PQC)',
    aliases: ['pqc', 'phu quoc', 'duong dong'],
  },
  {
    code: 'VII',
    text: 'Vinh International Airport (VII)',
    aliases: ['vii', 'vinh', 'nghe an'],
  },
  {
    code: 'BMV',
    text: 'Buon Ma Thuot Airport (BMV)',
    aliases: ['bmv', 'buon ma thuot', 'ban me thuot', 'dak lak'],
  },
  {
    code: 'TBB',
    text: 'Tuy Hoa Airport (TBB)',
    aliases: ['tbb', 'tuy hoa', 'phu yen'],
  },
  {
    code: 'CAH',
    text: 'Ca Mau Airport (CAH)',
    aliases: ['cah', 'ca mau'],
  },
  {
    code: 'VCL',
    text: 'Chu Lai Airport (VCL)',
    aliases: ['vcl', 'chu lai', 'quang nam', 'tam ky'],
  },
  {
    code: 'VCS',
    text: 'Con Dao Airport (VCS)',
    aliases: ['vcs', 'con dao', 'con son'],
  },
  {
    code: 'VTG',
    text: 'Vung Tau Airport (VTG)',
    aliases: ['vtg', 'vung tau'],
  },
  {
    code: 'DIN',
    text: 'Dien Bien Airport (DIN)',
    aliases: ['din', 'dien bien', 'dien bien phu'],
  },
  {
    code: 'VDH',
    text: 'Dong Hoi Airport (VDH)',
    aliases: ['vdh', 'dong hoi', 'quang binh'],
  },
  {
    code: 'PXU',
    text: 'Pleiku Airport (PXU)',
    aliases: ['pxu', 'pleiku', 'plei ku', 'gia lai'],
  },
  {
    code: 'UIH',
    text: 'Phu Cat Airport (UIH)',
    aliases: ['uih', 'quy nhon', 'qui nhon', 'phu cat', 'binh dinh'],
  },
  {
    code: 'VKG',
    text: 'Rach Gia Airport (VKG)',
    aliases: ['vkg', 'rach gia', 'kien giang'],
  },
  {
    code: 'THD',
    text: 'Tho Xuan Airport (THD)',
    aliases: ['thd', 'tho xuan', 'thanh hoa'],
  },
  {
    code: 'PHA',
    text: 'Phan Rang Air Base (PHA)',
    aliases: ['pha', 'phan rang', 'phan rang thap cham', 'ninh thuan'],
  },
  {
    code: 'LTH',
    text: 'Long Thanh International Airport (LTH)',
    aliases: ['lth', 'long thanh', 'dong nai'],
  },
] as const satisfies readonly AirportCatalogItem[];
