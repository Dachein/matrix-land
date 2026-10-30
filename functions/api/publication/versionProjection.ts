/**
 * Publication Listing version projection contract.
 *
 * A published or delisted Listing reads its listed version; a Listing under
 * review reads its review version. Version references may point at the Portal
 * publication version row, the display version, or either APPS version id
 * carried by the version config.
 *
 * Missing and unresolved pins deliberately project no version so a newer
 * review submission can never leak into a listed release.
 */
export const PUBLICATION_LISTING_VERSION_PROJECTION_CTE_SQL = `
  WITH publication_listing_projection AS (
    SELECT
      publication_listings.*,
      NULLIF(TRIM(
        CASE
          WHEN publication_listings.status IN ('listed', 'delisted')
            THEN publication_listings.listed_version_id
          WHEN publication_listings.status = 'pending_review'
            THEN publication_listings.review_version_id
          ELSE ''
        END
      ), '') AS projected_version_ref,
      NULLIF(TRIM(
        CASE
          WHEN publication_listings.effective_status IN ('listed', 'delisted')
            THEN publication_listings.listed_version_id
          WHEN publication_listings.effective_status = 'pending_review'
            THEN publication_listings.review_version_id
          ELSE ''
        END
      ), '') AS effective_projected_version_ref
    FROM publication_listings
  )
`;

export const PUBLICATION_EFFECTIVE_VERSION_PROJECTION_JOIN_SQL = `
  LEFT JOIN publication_versions AS projected_publication_version
    ON projected_publication_version.id = (
      SELECT candidate_publication_version.id
      FROM publication_versions AS candidate_publication_version
      WHERE candidate_publication_version.listing_id = publication_listings.id
        AND (
          candidate_publication_version.id = publication_listings.effective_projected_version_ref
          OR candidate_publication_version.version = publication_listings.effective_projected_version_ref
          OR CASE
            WHEN json_valid(candidate_publication_version.config_json)
              THEN json_extract(candidate_publication_version.config_json, '$.versionId')
            ELSE NULL
          END = publication_listings.effective_projected_version_ref
          OR CASE
            WHEN json_valid(candidate_publication_version.config_json)
              THEN json_extract(candidate_publication_version.config_json, '$.appsVerification.versionId')
            ELSE NULL
          END = publication_listings.effective_projected_version_ref
        )
      ORDER BY candidate_publication_version.created_at DESC, candidate_publication_version.id DESC
      LIMIT 1
    )
`;

export const PUBLICATION_VERSION_PROJECTION_JOIN_SQL = `
  LEFT JOIN publication_versions AS projected_publication_version
    ON projected_publication_version.id = (
      SELECT candidate_publication_version.id
      FROM publication_versions AS candidate_publication_version
      WHERE candidate_publication_version.listing_id = publication_listings.id
        AND (
          candidate_publication_version.id = publication_listings.projected_version_ref
          OR candidate_publication_version.version = publication_listings.projected_version_ref
          OR CASE
            WHEN json_valid(candidate_publication_version.config_json)
              THEN json_extract(candidate_publication_version.config_json, '$.versionId')
            ELSE NULL
          END = publication_listings.projected_version_ref
          OR CASE
            WHEN json_valid(candidate_publication_version.config_json)
              THEN json_extract(candidate_publication_version.config_json, '$.appsVerification.versionId')
            ELSE NULL
          END = publication_listings.projected_version_ref
        )
      ORDER BY candidate_publication_version.created_at DESC, candidate_publication_version.id DESC
      LIMIT 1
    )
`;
