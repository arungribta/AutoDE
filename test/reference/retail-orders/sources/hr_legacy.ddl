-- Irrelevant legacy HR schema (40 tables). Present only to test context dilution (trap 5):
-- none of it has anything to do with the retail revenue/retention problem.
CREATE TABLE hr_legacy.employees (
  employee_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.departments (
  department_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.job_titles (
  job_title_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.payroll_runs (
  payroll_run_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.payroll_lines (
  payroll_line_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.tax_codes (
  tax_code_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.benefits_plans (
  benefits_plan_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.benefit_enrollments (
  benefit_enrollment_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.leave_requests (
  leave_request_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.leave_balances (
  leave_balance_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.timesheets (
  timesheet_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.shifts (
  shift_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.shift_swaps (
  shift_swap_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.performance_reviews (
  performance_review_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.review_goals (
  review_goal_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.training_courses (
  training_course_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.training_enrollments (
  training_enrollment_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.certifications (
  certification_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.skills (
  skill_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.employee_skills (
  employee_skill_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.recruiters (
  recruiter_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.job_postings (
  job_posting_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.applicants (
  applicant_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.interviews (
  interview_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.offers (
  offer_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.onboarding_tasks (
  onboarding_task_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.offboarding_tasks (
  offboarding_task_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.expense_reports (
  expense_report_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.expense_lines (
  expense_line_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.cost_centers (
  cost_center_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.org_units (
  org_unit_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.positions (
  position_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.salary_bands (
  salary_band_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.bonus_awards (
  bonus_award_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.stock_grants (
  stock_grant_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.grievances (
  grievance_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.disciplinary_actions (
  disciplinary_action_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.safety_incidents (
  safety_incident_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.assets_issued (
  assets_issued_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);

CREATE TABLE hr_legacy.badge_access (
  badge_acce_id INTEGER PRIMARY KEY,
  code VARCHAR(32),
  description VARCHAR(255),
  effective_date DATE,
  legacy_flag BOOLEAN
);
