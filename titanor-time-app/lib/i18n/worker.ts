import type { AppLocale } from './locale';

// Worker-role-specific copy (Phase 1 of the EN/RU rollout). Foreman/Admin phases add sibling
// lib/i18n/foreman.ts / lib/i18n/admin.ts later without touching this file. Grouped by source
// file in comments purely for maintainability — the dictionary itself stays one flat interface,
// matching the proven app/login/i18n.ts LoginStrings shape.

export interface WorkerStrings {
  // -- WorkerClockPanel.tsx: describeErrorCode --
  errOutsideGeofence: string;
  errValidation: string;
  errDeviceRecordConflict: string;
  errSwitchSiteFailed: string;
  errRateLimited: string;
  errSessionExpired: string;
  errNoPermission: string;
  errDeviceNotOwned: string;
  errDeviceRevoked: string;
  errCouldNotReachServer: string;
  errActionNeedsAttention: string;
  // -- WorkerClockPanel.tsx: clock UI --
  syncOneOrMoreNeedAttention: string;
  synced: string;
  online: string;
  offline: string;
  pendingCount: (n: number) => string;
  syncNow: string;
  syncing: string;
  offlineSetupNotReadyConnecting: string;
  offlineSetupNotReadyConnectOnce: string;
  deviceNotLinked: string;
  deviceDisabled: string;
  sessionExpiredTitle: string;
  logInAgain: string;
  retry: string;
  nothingLost: string;
  clockedOut: string;
  checkInUpper: string;
  checkOutUpper: string;
  startWork: string;
  endWork: string;
  gpsCheckedAtAction: string;
  worker: string;
  workplaceLabel: string;
  workAreaLabel: string;
  noWorkplaceAssigned: string;
  changeWorkplace: string;
  switchWorkplace: string;
  close: string;
  statusInternet: string;
  statusSync: string;
  statusGps: string;
  statusSynced: string;
  statusWaitingCount: (n: number) => string;
  statusNeedsAttention: string;
  statusGpsChecking: string;
  statusGpsReady: string;
  statusGpsPermission: string;
  statusGpsUnavailable: string;
  statusGpsWillCheck: string;
  statusZone: string;
  statusZoneChecking: string;
  statusZoneInside: string;
  statusZoneOutside: string;
  statusZoneLowAccuracy: string;
  statusZoneUnavailable: string;
  workStatus: string;
  clockStateLabel: string;
  startedAtLabel: string;
  elapsedLabel: string;
  statusPendingActions: string;
  currentWorkplacePrefix: string;
  actionNeedsAttention: string;
  noSiteAssignedYet: string;
  primarySuffix: string;
  checkIn: string;
  clockedIn: string;
  waitingForSync: string;
  sinceTime: (time: string) => string;
  checkOut: string;
  switchSite: string;
  switchToDifferentSite: string;
  switchFromTo: (from: string, to: string) => string;
  confirmSwitch: string;
  cancel: string;
  gettingLocation: string;
  savedSyncing: string;
  savedWaitingForSync: string;
  offlineSetupNotReady: string;
  couldNotSaveAction: string;
  needsAttention: string;
  todaysTime: string;
  recentTime: string;
  timeCardTitle: string;
  today: string;
  recent: string;
  viewAndEditHours: string;
  noCompletedTimeEntries: string;
  myPeriods: string;
  historyLink: string;
  installAppLink: string;
  // -- DayEditor.tsx --
  errWorkSegmentOverlap: string;
  errSiteNotAssigned: string;
  errDayTypeConflict: string;
  errDayStateConflict: string;
  errDayTypeRequiresAbsence: string;
  errDraftNotEditable: string;
  errInvalidInput: string;
  errCouldNotSaveDay: string;
  clockAdjustmentReasonRequired: string;
  backArrow: string;
  absenceDayNotice: (dayType: string) => string;
  noHoursWorkedToday: string;
  paid: string;
  removeBreak: string;
  addBreak: string;
  removeInterval: string;
  addInterval: string;
  startLabel: string;
  endLabel: string;
  breakLabel: string;
  clockAdjustmentReasonLabel: string;
  clockAdjustmentReasonHelp: string;
  // -- SubmitButton.tsx --
  errSubmitAlreadySubmitted: string;
  errUnresolvedProposals: string;
  errCouldNotSubmit: string;
  submitting: string;
  submitTimesheet: string;
  // -- periods/page.tsx --
  yourPeriods: string;
  viewHistory: string;
  notAssignedToSiteYet: string;
  noOpenPeriodYet: string;
  // -- periods/[periodId]/page.tsx --
  periodNotAvailable: string;
  yourAssignments: string;
  enterHours: string;
  viewHours: string;
  // -- periods/[periodId]/hours/page.tsx --
  hours: string;
  readOnlyBeingReviewed: string;
  noDaysInPeriodYet: string;
  chooseAnotherDate: (n: number) => string;
  reviewAndSubmit: string;
  confirmedZeroShort: string;
  dayEmptyDash: string;
  needsCorrection: string;
  draftState: string;
  readOnly: string;
  // -- periods/[periodId]/submit/page.tsx --
  submitTimesheetTitle: string;
  backToHours: string;
  daysFilledIn: (worked: number, total: number, duration: string) => string;
  submitWarning: string;
  // -- history/page.tsx --
  historyTitle: string;
  currentPeriods: string;
  noPeriodsYet: string;
  // -- worker/install/page.tsx --
  installTitle: string;
  installLead: string;
  installBenefit1: string;
  installBenefit2: string;
  installBenefit3: string;
  // -- InstallPrompt.tsx --
  installChecking: string;
  installButton: string;
  installFinishing: string;
  installStartError: string;
  installInstalled: string;
  installIosLead: string;
  installIosStep1: string;
  installIosStep2: string;
  installIosStep3: string;
  installIosOtherBrowser: string;
  installDismissedLead: string;
  installAndroidLead: string;
  installGenericLead: string;
  installAndroidMenuStep: string;
  installGenericMenuStep: string;
  installLookForStep: string;
  installFollowPromptStep: string;
  installUnsupported: string;
  installOfflineNote: string;
  // -- ConnectivityBanner.tsx --
  connectivityBannerText: string;
  // -- WorkerAppNavigation.tsx --
  backToCheckInOut: string;
  // -- WorkerSnapshotView.tsx --
  snapUnavailable: string;
  snapInstallOffline: string;
  snapOfflineReadOnly: string;
  snapLastUpdated: (date: string) => string;
  snapReloadWhenOnline: string;
  snapReadOnlyOffline: string;
  snapConfirmedZeroHours: string;
  snapNoHoursLoggedDay: string;
  snapConnectToSubmit: string;
  // -- OfflineShellClient.tsx --
  offlineShellNotReady: string;
  // -- Day type labels (SICK_LEAVE/VACATION/UNPAID_LEAVE/OTHER, shared by DayEditor/hours-list/snapshot) --
  dayTypeLabels: Record<string, string>;
  // -- worker/profile/page.tsx + ProfileForm.tsx --
  profileTitle: string;
  profilePhotoLabel: string;
  profileUploadPhoto: string;
  profileRemovePhoto: string;
  profileNoPhoto: string;
  profileDateOfBirthLabel: string;
  profileSpecialtyLabel: string;
  profileSpecialtyPlaceholder: string;
  profileSkillsLabel: string;
  profileSkillsPlaceholder: string;
  profileSaveButton: string;
  profileSaving: string;
  profileSaved: string;
  profileSaveErrorConflict: string;
  profileUnsupportedPhotoType: string;
  profilePhotoTooLarge: string;
  // -- Worker Dossier feature (2026-08-26): contact/address + henkilötunnus, own profile --
  profileContactEmailLabel: string;
  profileAddressStreetLabel: string;
  profileAddressPostalCodeLabel: string;
  profileAddressCityLabel: string;
  profileAddressCountryLabel: string;
  profilePersonalIdentityCodeLabel: string;
  profilePersonalIdentityCodeShow: string;
  profilePersonalIdentityCodeHide: string;
  profilePersonalIdentityCodeNotSet: string;
  profilePersonalIdentityCodeInvalid: string;
  qualificationEditButton: string;
  qualificationSaveButton: string;
  qualificationCancelEdit: string;
  qualificationUploadPhotoButton: string;
  qualificationReplacePhotoButton: string;
  qualificationRemovePhotoButton: string;
  qualificationsTitle: string;
  qualificationsIntro: string;
  qualificationsEmpty: string;
  qualificationNameLabel: string;
  qualificationNamePlaceholder: string;
  qualificationExpiryLabel: string;
  qualificationPhotoLabel: string;
  qualificationAddButton: string;
  qualificationAdding: string;
  qualificationDeleteButton: string;
  qualificationExpired: string;
  qualificationExpiringSoon: string;
  qualificationCatalogLabel: string;
  qualificationCatalogOther: string;
  qualificationCatalogLoading: string;
  qualificationCertificateNumberLabel: string;
  qualificationIssuerLabel: string;
  qualificationIssuedOnLabel: string;
  qualificationVerifiedBadge: string;
  qualificationSelfReportedBadge: string;
  qualificationExpiresOnRequired: string;
  contractTitle: string;
  contractDownload: string;
  contractNone: string;
}

export const WORKER_STRINGS: Record<AppLocale, WorkerStrings> = {
  EN: {
    errOutsideGeofence: "You're outside this site's work area. Move closer and sync again.",
    errValidation: 'This record could not be validated. Please contact your administrator.',
    errDeviceRecordConflict: 'This device record conflicted with another one. Please contact your administrator.',
    errSwitchSiteFailed: 'This site switch could not be completed. Please contact your administrator.',
    errRateLimited: 'Too many attempts. Please wait a moment and try again.',
    errSessionExpired: 'Your session has expired.',
    errNoPermission: "You don't have permission to do that. Contact your administrator.",
    errDeviceNotOwned: 'This device is no longer linked to your account.',
    errDeviceRevoked: 'This device has been disabled by an administrator.',
    errCouldNotReachServer: "We couldn't reach the server. It will retry automatically.",
    errActionNeedsAttention: 'This action needs attention. Please contact your administrator.',
    syncOneOrMoreNeedAttention: 'One or more actions need attention — see below.',
    synced: 'Synced.',
    online: 'Online',
    offline: 'Offline',
    pendingCount: (n) => `${n} pending`,
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    offlineSetupNotReadyConnecting: 'Offline setup is not ready yet — connecting…',
    offlineSetupNotReadyConnectOnce: 'Offline setup is not ready yet. Connect to the internet once to finish setup.',
    deviceNotLinked: 'This device is not linked to your account.',
    deviceDisabled: 'This device has been disabled.',
    sessionExpiredTitle: 'Your session has expired.',
    logInAgain: 'Log in again →',
    retry: 'Retry',
    nothingLost: 'Nothing saved on this device has been lost.',
    clockedOut: 'Clocked out',
    checkInUpper: 'CHECK IN',
    checkOutUpper: 'CHECK OUT',
    startWork: 'Start work',
    endWork: 'End work',
    gpsCheckedAtAction: 'GPS checked when you clock in/out',
    worker: 'Worker',
    workplaceLabel: 'Workplace',
    workAreaLabel: 'Work area',
    noWorkplaceAssigned: 'No workplace assigned yet',
    changeWorkplace: 'Change workplace',
    switchWorkplace: 'Switch workplace',
    close: 'Close',
    statusInternet: 'Internet',
    statusSync: 'Sync',
    statusGps: 'GPS',
    statusSynced: 'Synced',
    statusWaitingCount: (n) => `${n} waiting`,
    statusNeedsAttention: 'Needs attention',
    statusGpsChecking: 'Checking…',
    statusGpsReady: 'Ready',
    statusGpsPermission: 'Permission needed',
    statusGpsUnavailable: 'Unavailable',
    statusGpsWillCheck: 'Checked at clock action',
    statusZone: 'Zone',
    statusZoneChecking: 'Checking…',
    statusZoneInside: 'In work zone',
    statusZoneOutside: 'Outside work zone',
    statusZoneLowAccuracy: 'Location too imprecise',
    statusZoneUnavailable: 'Unavailable',
    workStatus: 'Work status',
    clockStateLabel: 'Clock state',
    startedAtLabel: 'Started at',
    elapsedLabel: 'Elapsed',
    statusPendingActions: 'Pending actions',
    currentWorkplacePrefix: 'Current',
    actionNeedsAttention: 'Action needs attention',
    noSiteAssignedYet: 'Your manager has not assigned a site to you yet. You can use the app, but Check In will become available after a site is assigned.',
    primarySuffix: ' · Primary',
    checkIn: 'Check in',
    clockedIn: 'Clocked in',
    waitingForSync: ' (waiting for sync)',
    sinceTime: (time) => `Since ${time}`,
    checkOut: 'Check out',
    switchSite: 'Switch site',
    switchToDifferentSite: 'Switch to a different site',
    switchFromTo: (from, to) => `From ${from} to ${to}`,
    confirmSwitch: 'Confirm switch',
    cancel: 'Cancel',
    gettingLocation: 'Getting location…',
    savedSyncing: 'Saved on device — syncing…',
    savedWaitingForSync: 'Saved on device — waiting for sync.',
    offlineSetupNotReady: 'Offline setup is not ready yet.',
    couldNotSaveAction: 'Could not save this action on this device. Please try again.',
    needsAttention: 'Needs attention',
    todaysTime: "Today's time",
    recentTime: 'Recent time',
    timeCardTitle: 'Time',
    today: 'Today',
    recent: 'Recent',
    viewAndEditHours: 'View and edit hours',
    noCompletedTimeEntries: 'No completed time entries yet.',
    myPeriods: 'My periods →',
    historyLink: 'History →',
    installAppLink: 'Install app →',
    errWorkSegmentOverlap: 'These time ranges overlap — please adjust them.',
    errSiteNotAssigned: 'You are not assigned to that site/area on this date.',
    errDayTypeConflict: 'Cannot have hours logged and mark the day as absence at the same time.',
    errDayStateConflict: 'Cannot confirm zero hours while hours are logged.',
    errDayTypeRequiresAbsence: 'This day type requires an approved absence request.',
    errDraftNotEditable: 'This timesheet can no longer be edited.',
    errInvalidInput: 'Invalid input.',
    errCouldNotSaveDay: 'Could not save — please try again.',
    clockAdjustmentReasonRequired: 'A reason is required when changing or removing recorded Check In/Out time.',
    backArrow: '← Back',
    absenceDayNotice: (dayType) => `This day is marked as ${dayType}. Manage absences from your profile.`,
    noHoursWorkedToday: 'No hours worked today',
    paid: 'Paid',
    removeBreak: 'Remove break',
    addBreak: '+ Add break',
    removeInterval: 'Remove interval',
    addInterval: '+ Add interval',
    startLabel: 'Start',
    endLabel: 'End',
    breakLabel: 'Break',
    clockAdjustmentReasonLabel: 'Reason for changing recorded Check In/Out time',
    clockAdjustmentReasonHelp: 'Required only when a recorded interval is changed or removed. The reason is kept in the audit history.',
    errSubmitAlreadySubmitted: 'This timesheet can no longer be submitted (it may already be submitted).',
    errUnresolvedProposals: 'Some foreman proposals still need your response before you can submit.',
    errCouldNotSubmit: 'Could not submit — please try again.',
    submitting: 'Submitting…',
    submitTimesheet: 'Submit timesheet',
    yourPeriods: 'Your periods',
    viewHistory: 'View history →',
    notAssignedToSiteYet: "You haven't been assigned to a site yet.",
    noOpenPeriodYet: "You're assigned to a site, but no timesheet period is open for you yet. Please contact your administrator.",
    periodNotAvailable: 'This period is not available to you.',
    yourAssignments: 'Your assignments',
    enterHours: 'Enter hours',
    viewHours: 'View hours',
    hours: 'Hours',
    readOnlyBeingReviewed: 'Read-only — this timesheet is being reviewed.',
    noDaysInPeriodYet: 'No days in this period yet.',
    chooseAnotherDate: (n) => `Choose another date (${n})`,
    reviewAndSubmit: 'Review and submit',
    confirmedZeroShort: 'Confirmed 0h',
    dayEmptyDash: '—',
    needsCorrection: 'Needs correction',
    draftState: 'Draft',
    readOnly: 'Read only',
    submitTimesheetTitle: 'Submit timesheet',
    backToHours: '← Back to hours',
    daysFilledIn: (worked, total, duration) => `${worked} of ${total} days filled in · ${duration} total`,
    submitWarning: "Once submitted, you won't be able to edit your hours unless it's returned to you.",
    historyTitle: 'History',
    currentPeriods: '← Current periods',
    noPeriodsYet: 'No periods yet.',
    installTitle: 'Install Titanor Time',
    installLead: 'Add Titanor Time to your home screen for one-tap access and a working clock screen even when you lose signal.',
    installBenefit1: 'Opens straight to your clock — no address bar, no browser tabs.',
    installBenefit2: 'Check in and out still works after a full network drop, once set up.',
    installBenefit3: 'No extra download — it installs directly from this page.',
    installChecking: 'Checking install options…',
    installButton: 'Install Titanor Time',
    installFinishing: 'Finishing installation…',
    installStartError: "Something went wrong starting the install. You can try again, or use your browser's menu.",
    installInstalled: 'App is installed. Open it from your home screen or app list.',
    installIosLead: 'Install this app on your iPhone or iPad:',
    installIosStep1: "Tap the Share icon in Safari's toolbar.",
    installIosStep2: 'Scroll down and tap "Add to Home Screen".',
    installIosStep3: 'Tap "Add" to confirm.',
    installIosOtherBrowser: 'To install this app on iPhone or iPad, open this page in Safari — other browsers on iOS cannot add it to your home screen.',
    installDismissedLead: "Installation wasn't completed. You can still install the app from your browser's menu:",
    installAndroidLead: 'Install this app from your browser menu:',
    installGenericLead: "Install this app from your browser's menu:",
    installAndroidMenuStep: 'Tap the menu icon (usually three dots, ⋮) in your browser toolbar.',
    installGenericMenuStep: "Open your browser's menu (often three dots or lines) in the toolbar.",
    installLookForStep: 'Look for "Install app" or "Add to Home screen".',
    installFollowPromptStep: 'Follow the prompt to finish installing.',
    installUnsupported: 'This browser may not support installing the app as a shortcut. You can keep using it here in the browser — nothing else on this page requires installing.',
    installOfflineNote: 'Offline mode may not be available in this browser right now.',
    connectivityBannerText: 'Offline — clock actions on /worker are saved and will sync later. This page shows the last saved information.',
    backToCheckInOut: 'Back to Check In and Check Out',
    snapUnavailable: 'This page has not been saved for offline viewing yet. Connect and open it once.',
    snapInstallOffline: "You're offline. Installation guidance needs a connection to check your browser's install status.",
    snapOfflineReadOnly: 'Offline — read-only',
    snapLastUpdated: (date) => `Last updated: ${date}`,
    snapReloadWhenOnline: 'Reload when online',
    snapReadOnlyOffline: 'Read-only — offline snapshot.',
    snapConfirmedZeroHours: 'Confirmed 0 hours',
    snapNoHoursLoggedDay: 'No hours logged for this day.',
    snapConnectToSubmit: 'Connect to submit — this snapshot is read-only.',
    offlineShellNotReady: 'Offline setup is not ready. Connect to the internet once, open the app, and try again.',
    dayTypeLabels: {
      SICK_LEAVE: 'sick leave',
      VACATION: 'vacation',
      UNPAID_LEAVE: 'unpaid leave',
      OTHER: 'other'
    },
    profileTitle: 'Profile',
    profilePhotoLabel: 'Photo',
    profileUploadPhoto: 'Upload photo',
    profileRemovePhoto: 'Remove photo',
    profileNoPhoto: 'No photo uploaded.',
    profileDateOfBirthLabel: 'Date of birth',
    profileSpecialtyLabel: 'Specialty',
    profileSpecialtyPlaceholder: 'e.g. welder',
    profileSkillsLabel: 'Skills',
    profileSkillsPlaceholder: 'e.g. TIG, MAG, interior work',
    profileSaveButton: 'Save',
    profileSaving: 'Saving…',
    profileSaved: 'Saved.',
    profileSaveErrorConflict: 'This profile changed elsewhere — reload the page and try again.',
    profileUnsupportedPhotoType: 'Only JPG and PNG photos are supported.',
    profilePhotoTooLarge: 'This file is too large.',
    profileContactEmailLabel: 'Contact email',
    profileAddressStreetLabel: 'Street address',
    profileAddressPostalCodeLabel: 'Postal code',
    profileAddressCityLabel: 'City',
    profileAddressCountryLabel: 'Country',
    profilePersonalIdentityCodeLabel: 'Personal identity code',
    profilePersonalIdentityCodeShow: 'Show',
    profilePersonalIdentityCodeHide: 'Hide',
    profilePersonalIdentityCodeNotSet: 'Not set',
    profilePersonalIdentityCodeInvalid: 'Invalid personal identity code',
    qualificationEditButton: 'Edit',
    qualificationSaveButton: 'Save',
    qualificationCancelEdit: 'Cancel',
    qualificationUploadPhotoButton: 'Upload image',
    qualificationReplacePhotoButton: 'Replace image',
    qualificationRemovePhotoButton: 'Remove image',
    qualificationsTitle: 'Qualification cards',
    qualificationsIntro: 'E.g. a hot-work permit or safety card — with an expiry date if there is one.',
    qualificationsEmpty: 'No cards yet.',
    qualificationNameLabel: 'Name',
    qualificationNamePlaceholder: 'e.g. Hot-work permit',
    qualificationExpiryLabel: 'Valid until',
    qualificationPhotoLabel: 'Photo (optional)',
    qualificationAddButton: 'Add card',
    qualificationAdding: 'Adding…',
    qualificationDeleteButton: 'Delete',
    qualificationExpired: 'Expired',
    qualificationExpiringSoon: 'Expiring soon',
    qualificationCatalogLabel: 'Qualification',
    qualificationCatalogOther: 'Other (custom)',
    qualificationCatalogLoading: 'Loading…',
    qualificationCertificateNumberLabel: 'Certificate number',
    qualificationIssuerLabel: 'Issuer',
    qualificationIssuedOnLabel: 'Issued on',
    qualificationVerifiedBadge: 'Verified',
    qualificationSelfReportedBadge: 'Self-reported',
    qualificationExpiresOnRequired: 'This qualification requires an expiry date.',
    contractTitle: 'Contract',
    contractDownload: 'Download contract',
    contractNone: 'No contract attached yet.'
  },
  RU: {
    errOutsideGeofence: 'Вы находитесь за пределами рабочей зоны объекта. Подойдите ближе и синхронизируйте снова.',
    errValidation: 'Не удалось проверить эту запись. Обратитесь к администратору.',
    errDeviceRecordConflict: 'Запись устройства конфликтует с другой. Обратитесь к администратору.',
    errSwitchSiteFailed: 'Не удалось переключить объект. Обратитесь к администратору.',
    errRateLimited: 'Слишком много попыток. Подождите немного и попробуйте снова.',
    errSessionExpired: 'Сессия истекла.',
    errNoPermission: 'У вас нет прав на это действие. Обратитесь к администратору.',
    errDeviceNotOwned: 'Это устройство больше не привязано к вашей учётной записи.',
    errDeviceRevoked: 'Это устройство отключено администратором.',
    errCouldNotReachServer: 'Не удалось связаться с сервером. Повтор будет выполнен автоматически.',
    errActionNeedsAttention: 'Это действие требует внимания. Обратитесь к администратору.',
    syncOneOrMoreNeedAttention: 'Одно или несколько действий требуют внимания — см. ниже.',
    synced: 'Синхронизировано.',
    online: 'Онлайн',
    offline: 'Офлайн',
    pendingCount: (n) => `Ожидает: ${n}`,
    syncNow: 'Синхронизировать',
    syncing: 'Синхронизация…',
    offlineSetupNotReadyConnecting: 'Офлайн-режим ещё не настроен — подключение…',
    offlineSetupNotReadyConnectOnce: 'Офлайн-режим ещё не настроен. Подключитесь к интернету один раз, чтобы завершить настройку.',
    deviceNotLinked: 'Это устройство не привязано к вашей учётной записи.',
    deviceDisabled: 'Это устройство отключено.',
    sessionExpiredTitle: 'Сессия истекла.',
    logInAgain: 'Войти снова →',
    retry: 'Повторить',
    nothingLost: 'Ничего из сохранённого на этом устройстве не потеряно.',
    clockedOut: 'Не на смене',
    checkInUpper: 'CHECK IN',
    checkOutUpper: 'CHECK OUT',
    startWork: 'Начать работу',
    endWork: 'Завершить работу',
    gpsCheckedAtAction: 'GPS проверяется при отметке прихода/ухода',
    worker: 'Работник',
    workplaceLabel: 'Объект',
    workAreaLabel: 'Участок',
    noWorkplaceAssigned: 'Объект ещё не назначен',
    changeWorkplace: 'Сменить объект',
    switchWorkplace: 'Переключить объект',
    close: 'Закрыть',
    statusInternet: 'Интернет',
    statusSync: 'Синхронизация',
    statusGps: 'GPS',
    statusSynced: 'Синхронизировано',
    statusWaitingCount: (n) => `Ожидает: ${n}`,
    statusNeedsAttention: 'Требует внимания',
    statusGpsChecking: 'Проверка…',
    statusGpsReady: 'Готово',
    statusGpsPermission: 'Нужен доступ',
    statusGpsUnavailable: 'Недоступно',
    statusGpsWillCheck: 'Проверяется при отметке',
    statusZone: 'Зона',
    statusZoneChecking: 'Проверяем…',
    statusZoneInside: 'В рабочей зоне',
    statusZoneOutside: 'Вне рабочей зоны',
    statusZoneLowAccuracy: 'Слишком неточно',
    statusZoneUnavailable: 'Недоступно',
    workStatus: 'Статус работы',
    clockStateLabel: 'Состояние',
    startedAtLabel: 'Начато в',
    elapsedLabel: 'Прошло',
    statusPendingActions: 'Ожидающие действия',
    currentWorkplacePrefix: 'Текущий объект:',
    actionNeedsAttention: 'Действие требует внимания',
    noSiteAssignedYet: 'Руководитель ещё не назначил вам объект. Вы можете пользоваться приложением, но отметка прихода станет доступна после назначения объекта.',
    primarySuffix: ' · Основной',
    checkIn: 'Отметить приход',
    clockedIn: 'На смене',
    waitingForSync: ' (ожидает синхронизации)',
    sinceTime: (time) => `С ${time}`,
    checkOut: 'Отметить уход',
    switchSite: 'Сменить объект',
    switchToDifferentSite: 'Переключиться на другой объект',
    switchFromTo: (from, to) => `С «${from}» на «${to}»`,
    confirmSwitch: 'Подтвердить переключение',
    cancel: 'Отмена',
    gettingLocation: 'Определение местоположения…',
    savedSyncing: 'Сохранено на устройстве — синхронизация…',
    savedWaitingForSync: 'Сохранено на устройстве — ожидает синхронизации.',
    offlineSetupNotReady: 'Офлайн-режим ещё не настроен.',
    couldNotSaveAction: 'Не удалось сохранить это действие на устройстве. Попробуйте ещё раз.',
    needsAttention: 'Требует внимания',
    todaysTime: 'Время за сегодня',
    recentTime: 'Недавнее время',
    timeCardTitle: 'Время',
    today: 'Сегодня',
    recent: 'Недавно',
    viewAndEditHours: 'Смотреть и редактировать часы',
    noCompletedTimeEntries: 'Завершённых записей времени пока нет.',
    myPeriods: 'Мои периоды →',
    historyLink: 'История →',
    installAppLink: 'Установить приложение →',
    errWorkSegmentOverlap: 'Эти интервалы времени пересекаются — скорректируйте их.',
    errSiteNotAssigned: 'Вы не назначены на этот объект/область в эту дату.',
    errDayTypeConflict: 'Нельзя одновременно указать часы работы и отметить день как отсутствие.',
    errDayStateConflict: 'Нельзя подтвердить нулевые часы, пока указаны рабочие часы.',
    errDayTypeRequiresAbsence: 'Этот тип дня требует одобренной заявки на отсутствие.',
    errDraftNotEditable: 'Этот табель больше нельзя редактировать.',
    errInvalidInput: 'Некорректные данные.',
    errCouldNotSaveDay: 'Не удалось сохранить — попробуйте ещё раз.',
    clockAdjustmentReasonRequired: 'При изменении или удалении зафиксированного времени прихода/ухода необходимо указать причину.',
    backArrow: '← Назад',
    absenceDayNotice: (dayType) => `Этот день отмечен как «${dayType}». Управляйте отсутствиями в своём профиле.`,
    noHoursWorkedToday: 'Сегодня часов не отработано',
    paid: 'Оплачиваемый',
    removeBreak: 'Удалить перерыв',
    addBreak: '+ Добавить перерыв',
    removeInterval: 'Удалить интервал',
    addInterval: '+ Добавить интервал',
    startLabel: 'Начало',
    endLabel: 'Конец',
    breakLabel: 'Перерыв',
    clockAdjustmentReasonLabel: 'Причина изменения зафиксированного времени прихода/ухода',
    clockAdjustmentReasonHelp: 'Требуется, только если зафиксированный интервал изменён или удалён. Причина сохраняется в истории аудита.',
    errSubmitAlreadySubmitted: 'Этот табель больше нельзя отправить (возможно, он уже отправлен).',
    errUnresolvedProposals: 'Прежде чем отправить табель, ответьте на предложения прораба.',
    errCouldNotSubmit: 'Не удалось отправить — попробуйте ещё раз.',
    submitting: 'Отправка…',
    submitTimesheet: 'Отправить табель',
    yourPeriods: 'Ваши периоды',
    viewHistory: 'Смотреть историю →',
    notAssignedToSiteYet: 'Вы ещё не назначены на объект.',
    noOpenPeriodYet: 'Вы назначены на объект, но период учёта времени для вас пока не открыт. Обратитесь к администратору.',
    periodNotAvailable: 'Этот период вам недоступен.',
    yourAssignments: 'Ваши назначения',
    enterHours: 'Внести часы',
    viewHours: 'Смотреть часы',
    hours: 'Часы',
    readOnlyBeingReviewed: 'Только просмотр — этот табель на проверке.',
    noDaysInPeriodYet: 'В этом периоде пока нет дней.',
    chooseAnotherDate: (n) => `Выбрать другую дату (${n})`,
    reviewAndSubmit: 'Проверить и отправить',
    confirmedZeroShort: 'Подтверждено 0ч',
    dayEmptyDash: '—',
    needsCorrection: 'Нужно исправить',
    draftState: 'Черновик',
    readOnly: 'Только просмотр',
    submitTimesheetTitle: 'Отправить табель',
    backToHours: '← К часам',
    daysFilledIn: (worked, total, duration) => `Заполнено ${worked} из ${total} дней · всего ${duration}`,
    submitWarning: 'После отправки вы не сможете редактировать часы, пока табель не будет возвращён вам.',
    historyTitle: 'История',
    currentPeriods: '← Текущие периоды',
    noPeriodsYet: 'Периодов пока нет.',
    installTitle: 'Установить Titanor Time',
    installLead: 'Добавьте Titanor Time на главный экран для доступа в один тап и работающего экрана учёта времени даже при потере связи.',
    installBenefit1: 'Открывается сразу на экране учёта времени — без адресной строки и вкладок браузера.',
    installBenefit2: 'После настройки отметка прихода/ухода продолжает работать даже при полном отключении сети.',
    installBenefit3: 'Без дополнительной загрузки — устанавливается прямо с этой страницы.',
    installChecking: 'Проверка возможности установки…',
    installButton: 'Установить Titanor Time',
    installFinishing: 'Завершение установки…',
    installStartError: 'Не удалось начать установку. Попробуйте ещё раз или используйте меню браузера.',
    installInstalled: 'Приложение установлено. Откройте его с главного экрана или из списка приложений.',
    installIosLead: 'Установите это приложение на iPhone или iPad:',
    installIosStep1: 'Нажмите значок «Поделиться» на панели инструментов Safari.',
    installIosStep2: 'Прокрутите вниз и нажмите «На экран «Домой»».',
    installIosStep3: 'Нажмите «Добавить» для подтверждения.',
    installIosOtherBrowser: 'Чтобы установить это приложение на iPhone или iPad, откройте страницу в Safari — другие браузеры на iOS не могут добавлять приложения на главный экран.',
    installDismissedLead: 'Установка не завершена. Вы всё ещё можете установить приложение через меню браузера:',
    installAndroidLead: 'Установите это приложение через меню браузера:',
    installGenericLead: 'Установите это приложение через меню браузера:',
    installAndroidMenuStep: 'Нажмите значок меню (обычно три точки, ⋮) на панели браузера.',
    installGenericMenuStep: 'Откройте меню браузера (часто это три точки или линии) на панели инструментов.',
    installLookForStep: 'Найдите пункт «Установить приложение» или «Добавить на главный экран».',
    installFollowPromptStep: 'Следуйте подсказкам, чтобы завершить установку.',
    installUnsupported: 'Этот браузер может не поддерживать установку приложения как ярлыка. Вы можете продолжать пользоваться им в браузере — установка не требуется ни для чего на этой странице.',
    installOfflineNote: 'Офлайн-режим может быть сейчас недоступен в этом браузере.',
    connectivityBannerText: 'Офлайн — действия учёта времени на /worker сохраняются и синхронизируются позже. На этой странице показаны последние сохранённые данные.',
    backToCheckInOut: 'Назад к отметке прихода и ухода',
    snapUnavailable: 'Эта страница ещё не сохранена для просмотра офлайн. Подключитесь к интернету и откройте её один раз.',
    snapInstallOffline: 'Вы офлайн. Для проверки статуса установки в вашем браузере нужно подключение к интернету.',
    snapOfflineReadOnly: 'Офлайн — только просмотр',
    snapLastUpdated: (date) => `Обновлено: ${date}`,
    snapReloadWhenOnline: 'Обновить при подключении',
    snapReadOnlyOffline: 'Только просмотр — офлайн-снимок.',
    snapConfirmedZeroHours: 'Подтверждено 0 часов',
    snapNoHoursLoggedDay: 'За этот день часы не зафиксированы.',
    snapConnectToSubmit: 'Подключитесь к интернету, чтобы отправить — этот снимок доступен только для просмотра.',
    offlineShellNotReady: 'Офлайн-режим ещё не настроен. Подключитесь к интернету один раз, откройте приложение и попробуйте снова.',
    dayTypeLabels: {
      SICK_LEAVE: 'больничный',
      VACATION: 'отпуск',
      UNPAID_LEAVE: 'отпуск без содержания',
      OTHER: 'другое'
    },
    profileTitle: 'Профиль',
    profilePhotoLabel: 'Фото',
    profileUploadPhoto: 'Загрузить фото',
    profileRemovePhoto: 'Удалить фото',
    profileNoPhoto: 'Фото не загружено.',
    profileDateOfBirthLabel: 'Дата рождения',
    profileSpecialtyLabel: 'Специальность',
    profileSpecialtyPlaceholder: 'например, сварщик',
    profileSkillsLabel: 'Навыки',
    profileSkillsPlaceholder: 'например, TIG, MAG, работа по интерьеру',
    profileSaveButton: 'Сохранить',
    profileSaving: 'Сохранение…',
    profileSaved: 'Сохранено.',
    profileSaveErrorConflict: 'Профиль изменён в другом месте — обновите страницу и попробуйте снова.',
    profileUnsupportedPhotoType: 'Поддерживаются только фото JPG и PNG.',
    profilePhotoTooLarge: 'Файл слишком большой.',
    profileContactEmailLabel: 'Контактный email',
    profileAddressStreetLabel: 'Улица, дом',
    profileAddressPostalCodeLabel: 'Почтовый индекс',
    profileAddressCityLabel: 'Город',
    profileAddressCountryLabel: 'Страна',
    profilePersonalIdentityCodeLabel: 'Личный идентификационный код',
    profilePersonalIdentityCodeShow: 'Показать',
    profilePersonalIdentityCodeHide: 'Скрыть',
    profilePersonalIdentityCodeNotSet: 'Не указан',
    profilePersonalIdentityCodeInvalid: 'Некорректный личный идентификационный код',
    qualificationEditButton: 'Изменить',
    qualificationSaveButton: 'Сохранить',
    qualificationCancelEdit: 'Отмена',
    qualificationUploadPhotoButton: 'Загрузить изображение',
    qualificationReplacePhotoButton: 'Заменить изображение',
    qualificationRemovePhotoButton: 'Удалить изображение',
    qualificationsTitle: 'Карточки квалификации',
    qualificationsIntro: 'Например, огненные работы или карта безопасности труда — с датой окончания, если есть.',
    qualificationsEmpty: 'Карточек пока нет.',
    qualificationNameLabel: 'Название',
    qualificationNamePlaceholder: 'например, Огненные работы',
    qualificationExpiryLabel: 'Действует до',
    qualificationPhotoLabel: 'Фото (необязательно)',
    qualificationAddButton: 'Добавить карточку',
    qualificationAdding: 'Добавление…',
    qualificationDeleteButton: 'Удалить',
    qualificationExpired: 'Истекло',
    qualificationExpiringSoon: 'Скоро истекает',
    qualificationCatalogLabel: 'Квалификация',
    qualificationCatalogOther: 'Другое (свой вариант)',
    qualificationCatalogLoading: 'Загрузка…',
    qualificationCertificateNumberLabel: 'Номер сертификата',
    qualificationIssuerLabel: 'Кем выдано',
    qualificationIssuedOnLabel: 'Дата выдачи',
    qualificationVerifiedBadge: 'Подтверждено',
    qualificationSelfReportedBadge: 'Указано самостоятельно',
    qualificationExpiresOnRequired: 'Для этой квалификации нужно указать срок действия.',
    contractTitle: 'Договор',
    contractDownload: 'Скачать договор',
    contractNone: 'Договор ещё не прикреплён.'
  }
};

/** Graceful fallback for a day type not in the map — returns the raw normalized value rather than crashing. */
export function dayTypeLabel(dayType: string, locale: AppLocale): string {
  const key = dayType.toUpperCase();
  return WORKER_STRINGS[locale].dayTypeLabels[key] ?? dayType.replace('_', ' ').toLowerCase();
}
