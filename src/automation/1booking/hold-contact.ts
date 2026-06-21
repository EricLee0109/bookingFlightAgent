import { type Locator, type Page } from 'playwright';

export type OneBookingHoldContactInfo = {
  phoneNumber: string;
  email: string;
  contactName: string;
};

/**
 * Reads required 1Booking hold-contact defaults from environment variables.
 *
 * These fields belong to the buyer/contact section of the 1Booking hold form,
 * not to the passenger profile stored in SQLite.
 */
export function readOneBookingHoldContactInfoFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OneBookingHoldContactInfo {
  const phoneNumber = env.ONE_BOOKING_HOLD_PHONENUMBER?.trim();
  const email = env.ONE_BOOKING_HOLD_EMAIL?.trim();
  const contactName = env.ONE_BOOKING_HOLD_NAME?.trim();
  const missingFields: string[] = [];

  if (!phoneNumber) missingFields.push('ONE_BOOKING_HOLD_PHONENUMBER');
  if (!email) missingFields.push('ONE_BOOKING_HOLD_EMAIL');
  if (!contactName) missingFields.push('ONE_BOOKING_HOLD_NAME');

  if (missingFields.length > 0) {
    throw new Error(
      `Missing 1Booking hold contact info in .env: ${missingFields.join(', ')}.`,
    );
  }

  return {
    phoneNumber: phoneNumber ?? '',
    email: email ?? '',
    contactName: contactName ?? '',
  };
}

/**
 * Fills and asserts the buyer/contact fields required before 1Booking hold.
 *
 * 1Booking now blocks `Xác nhận` unless the `Liên hệ` section has phone, email,
 * and contact name. This helper owns only those contact fields.
 */
export async function fillAndAssertHoldContactInformation(
  page: Page,
  contactInfo: OneBookingHoldContactInfo,
) {
  await ensureContactSectionVisible(page);

  await fillVisibleInput(
    getPhoneNumberInput(page),
    contactInfo.phoneNumber,
    'holdContactPhoneNumber',
  );
  await fillVisibleInput(
    getEmailInput(page),
    contactInfo.email,
    'holdContactEmail',
  );
  await fillVisibleInput(
    getContactNameInput(page),
    contactInfo.contactName,
    'holdContactName',
  );
}

/**
 * Scrolls to the 1Booking contact section and expands it if needed.
 */
async function ensureContactSectionVisible(page: Page) {
  const contactHeading = page.getByText(/^Liên hệ$|^Lien he$/i).first();

  await contactHeading.waitFor({
    state: 'visible',
    timeout: 15000,
  });
  await contactHeading.scrollIntoViewIfNeeded();

  if (
    !(await getPhoneNumberInput(page)
      .isVisible({
        timeout: 1000,
      })
      .catch(() => false))
  ) {
    await contactHeading.click();
  }
}

function getPhoneNumberInput(page: Page) {
  return page.getByPlaceholder(/^Nhập số điện thoại$|^Nhap so dien thoai$/i).first();
}

function getEmailInput(page: Page) {
  return page.getByPlaceholder(/^Nhập email$|^Nhap email$/i).first();
}

function getContactNameInput(page: Page) {
  return page.getByPlaceholder(/^Nhập tên liên hệ$|^Nhap ten lien he$/i).first();
}

async function fillVisibleInput(
  input: Locator,
  value: string,
  fieldName: string,
) {
  await input.waitFor({
    state: 'visible',
    timeout: 10000,
  });
  await input.fill(value);

  const actualValue = await input.inputValue();

  if (actualValue.trim() !== value.trim()) {
    throw new Error(
      `1Booking ${fieldName} assertion failed after contact fill.`,
    );
  }
}
