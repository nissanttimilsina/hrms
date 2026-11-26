// Loaded first by every test file: points the app at the isolated test DB / Redis DB 1.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL_OWNER ??= 'postgresql://hrms_owner:owner_pw@localhost:5432/hrms_test';
process.env.DATABASE_URL_APP ??= 'postgresql://hrms_app:app_pw@localhost:5432/hrms_test';
process.env.DATABASE_URL_SYSTEM ??= 'postgresql://hrms_system:system_pw@localhost:5432/hrms_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.ROOT_DOMAIN = 'hrms.test';
process.env.APP_HOST = 'app.hrms.test';
process.env.ADMIN_HOST = 'admin.hrms.test';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = '0';
