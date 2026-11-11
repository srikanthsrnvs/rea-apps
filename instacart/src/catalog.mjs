import { createHash } from 'node:crypto';

// Exact native documents: whitespace is significant for registered APQ hashes.
// Instacart Android 9.39.2, base.apk SHA-256 f6e451263f43a1169aab0319244b17d77c7ace598f5666cb3a61da60d0d50dd1.
export const CATALOG_DOCUMENTS = Object.freeze({
  "UserAddresses": "query UserAddresses { userAddresses { __typename ...UsersAddressData } }  fragment Coordinates on SharedGpsCoordinates { latitude longitude }  fragment FormattedString on ViewFormattedString { sections { name content } }  fragment UsersAddressData on UsersAddress { id businessClient { businessClientExternalId } businessName addressName addressCategory label labelType apartmentNumber streetAddress postalCode coordinates { __typename ...Coordinates } zoneId dropoffLocation manualCoordinates { __typename ...Coordinates } viewSection { addressCategoryIcon cityStateString lineOneDisplayString lineTwoDisplayString lineOneString lineOneDisplayString lineTwoString showRichDisplayFieldsVariant validationErrorStringFormatted { __typename ...FormattedString } trackingProperties } accessCode deliveryContact { name phone } validationChange validationErrors validationWarnings unattendedDelivery addressLocationPhoto { id photoUrl } instructions accessCode floorNumber }",
  "ShopCollectionUnscoped": "query ShopCollectionUnscoped($postalCode: String!, $coordinates: UsersCoordinatesInput!, $addressId: ID) { shopCollection(postalCode: $postalCode, coordinates: $coordinates, addressId: $addressId) { __typename ...ShopCollection } }  fragment ImageModel on Image { altText height width templateUrl url }  fragment Shop on RetailersShop { id retailerLocationId serviceType alcoholBrowsable fulfillmentProviderId retailer { id name slug retailerType logoBackgroundColorHex refreshHeaderBackgroundColorHex refreshHeaderBackgroundColorHexV2 viewSection { logoImage { __typename ...ImageModel } trackingProperties } } viewSection { deliveryString pickupString trackingProperties } }  fragment ShopCollection on RetailersShopCollection { viewSection { trackingProperties } shops { __typename ...Shop } }",
  "ShopCollectionScoped": "query ShopCollectionScoped($postalCode: String!, $coordinates: UsersCoordinatesInput!, $addressId: ID, $retailerIds: [ID!], $retailerSlugs: [String!]) { shopCollection(postalCode: $postalCode, coordinates: $coordinates, addressId: $addressId, retailerIds: $retailerIds, retailerSlugs: $retailerSlugs) { __typename ...ShopCollection } }  fragment ImageModel on Image { altText height width templateUrl url }  fragment Shop on RetailersShop { id retailerLocationId serviceType alcoholBrowsable fulfillmentProviderId retailer { id name slug retailerType logoBackgroundColorHex refreshHeaderBackgroundColorHex refreshHeaderBackgroundColorHexV2 viewSection { logoImage { __typename ...ImageModel } trackingProperties } } viewSection { deliveryString pickupString trackingProperties } }  fragment ShopCollection on RetailersShopCollection { viewSection { trackingProperties } shops { __typename ...Shop } }",
  "Shop": "query Shop($shopId: ID!) { shop(id: $shopId) { __typename ...Shop } }  fragment ImageModel on Image { altText height width templateUrl url }  fragment Shop on RetailersShop { id retailerLocationId serviceType alcoholBrowsable fulfillmentProviderId retailer { id name slug retailerType logoBackgroundColorHex refreshHeaderBackgroundColorHex refreshHeaderBackgroundColorHexV2 viewSection { logoImage { __typename ...ImageModel } trackingProperties } } viewSection { deliveryString pickupString trackingProperties } }",
  "SearchItems": "query SearchItems($shopId: ID!, $postalCode: String!, $query: String!, $queries: [String!], $searchSource: String!, $searchOptions: SearchSearchOptions, $autosuggestImpressionId: ID, $crossRetailerImpressionId: ID, $searchId: ID, $includeDebugInfo: Boolean = false , $searchConfigIdentifier: SearchSearchConfigIdentifier, $pageViewId: ID, $llmSearchType: String, $parentSearchProductCategoryIds: [Int!], $action: SearchContentManagementSearchAction, $hydrateItemPrice: Boolean = false , $itemShopId: ID = \"\" , $itemZoneId: ID = \"\" , $itemPostalCode: String = \"\" ) { itemSearch(shopId: $shopId, postalCode: $postalCode, query: $query, queries: $queries, searchSource: $searchSource, searchOptions: $searchOptions, autosuggestImpressionId: $autosuggestImpressionId, crossRetailerImpressionId: $crossRetailerImpressionId, searchId: $searchId, includeDebugInfo: $includeDebugInfo, searchConfigIdentifier: $searchConfigIdentifier, pageViewId: $pageViewId, llmSearchType: $llmSearchType, parentSearchProductCategoryIds: $parentSearchProductCategoryIds, action: $action) { itemResultList { __typename ...SearchItemResultListData } productBadges { productId viewSection { badge { __typename ...ProductBadge } } } viewSection { zeroItemResult { titleString bodyString actionVariant actionLabelString primaryImage { __typename ...ImageModel } hideSpecialRequestString pickupLocationsPathString viewTrackingEvent { name } trackingProperties } } searchId } }  fragment TrackingEvent on Tracking { name properties }  fragment FormattedAttributesString on ViewFormattedAttributesString { sections { name text styles { backgroundColor color colorHex italic underline highlight typography } navigation { navigate { __typename ... on ViewFormattedAttributesStringNavigateToUrl { url } } } } }  fragment PriceBadge on ItemsResponseBackedItemPriceBadgeSection { badgeVariant offerLabelString actionLabelString offerReferenceString promotionClickCtaClientTrackingEventName promotionClipClientTrackingEventName trackingProperties viewableTrackingEventName couponAppliedString couponClippedVariant applyCouponString eligibleItemsUxVariant multiUnitClippablePromotionVariant itemMultiplePromotionsVariant multiplePromotionsLabelString offerBrandingFormattedAttributesString { __typename ...FormattedAttributesString } }  fragment FormattedString on ViewFormattedString { sections { name content } }  fragment ItemPromotions on ItemsResponseBackedItemPriceItemPromotionSection { applyCouponString badgeVariant couponAppliedString couponClippedVariant multiUnitClippablePromotionVariant offerLabelString offerLoadIdString offerReferenceString offerSublabelString offerUniqueIdString }  fragment ImageModel on Image { altText height width templateUrl url }  fragment SecondaryPromotion on ItemsResponseBackedItemPriceSecondaryPromotionSection { id badgeVariant logoImage { __typename ...ImageModel } offerLabelString }  fragment SizeSelectorFields on ItemsResponseBackedItemPriceSizeSelectorSection { unitLabelString priceString fullPriceString pricePerMeasureString caseLabelString casePricePerItemString casePriceString caseFullPriceString casePriceStringFormatted { __typename ...FormattedString } casePricingPerMeasureString caseQuantityString modalTitleString viewFullDetailsString loadTrackingEventName displayTrackingEventName engagementTrackingEventName }  fragment ItemPrice on ItemsItemPrice { itemId greatPrice { viewSection { labelString trackingProperties } } viewSection { itemDetails { dealAppliedLabelString totalOptionsString pricePerUnitString } badge { __typename ...PriceBadge } fullPriceString priceString itemCard { fullPriceString priceString priceDollarsString priceCentsString priceSuffixString priceBackgroundVariant pricingUnitSecondaryString pricingUnitString priceAriaLabelString trackingProperties loyaltyProgramLabelString loyaltyProgramSmallLabelString loyaltyProgramVariant loyaltyPriceStringPositionVariant loyaltyPriceStringFormatted { __typename ...FormattedString } nonLoyaltyPriceStringFormatted { __typename ...FormattedString } priceStringFormatted { __typename ...FormattedString } secondaryBottomStringFormatted { __typename ...FormattedString } secondaryTopStringFormatted { __typename ...FormattedString } loyaltyPriceStringPositionVariant smartDiscountFormattedAttributesString { __typename ...FormattedAttributesString } taxDisclaimerFormattedAttributesString { __typename ...FormattedAttributesString } } itemPromotions { __typename ...ItemPromotions } secondaryPromotion { __typename ...SecondaryPromotion } sizeSelector { __typename ...SizeSelectorFields } trackingProperties } }  fragment BlackoutTime on ItemsBlackoutTime { startHour endHour weekday }  fragment AvailabilityBadgeData on ItemsAvailability { isUpcomingProduct isItemAvailabilityLifecycleEnabled stockLevel viewSection { stockLevelLabelString stockLevelLabelColor stockLevelIconIcon upcomingProductAvailableFromString } }  fragment Quantity on ItemsQuantityAttributes { increment initial max min quantityType parWeight { quantity } viewSection { unitString maxedOutString minReachedString variableWeightDisclaimerString iconUnitTypeVisibilityVariant stepperUnitTypeVisibilityVariant totalWeightEstimateTemplatePluralString totalWeightEstimateTemplateString quantityUnitVisibilityVariant parWeightDisplayString soldByUnitString } }  fragment ItemData on ItemsItem { id itemLoadId legacyId legacyV3Id name brandName brandId productId externalSku productCategoryName configurableProductId isCatering dietary { mlShoppingAttributes viewSection { attributeSections { attributeString discoveryPageSlugString itemCardVisibilityVariant itemDetailsVisibilityVariant trackingProperties colorHexString iconImage { resizedUrl(width: 160, height: 160) } loadTrackingEvent { __typename ...TrackingEvent } displayTrackingEvent { __typename ...TrackingEvent } engagementTrackingEvent { __typename ...TrackingEvent } } } } nutritionalAttributes { id nutrient viewSection { longLabelString shortLabelString unitString valueString } } price(shopId: $itemShopId, zoneId: $itemZoneId, postalCode: $itemPostalCode) @include(if: $hydrateItemPrice) { __typename ...ItemPrice } productRating { amount value viewSection { amountString ratingColor } } productScores { nutriscore viewSection { nutritionScoreQualifierString nutritionScoreTitleString engagementTrackingEvent { __typename ...TrackingEvent } trackingProperties } } availability { __typename available blackoutTimes { __typename ...BlackoutTime } ...AvailabilityBadgeData viewSection { warningIconImage { __typename ...ImageModel } outOfStockCtaString } } quantityAttributes { __typename ...Quantity } retailerId size tags variantDimensionValues variantGroupId variantGroup { viewSection { optionsSummaryString itemCardSubtextStringFormatted { __typename ...FormattedString } variantsItemCardSubtextStringFormatted { __typename ...FormattedString } variantsItemCardSubtextSimpleStringFormatted { __typename ...FormattedString } trackingProperties } } viewSection { itemString itemImage { __typename ...ImageModel } lowStockVariant itemCardHideQuickAddPriceVariant trackingProperties requestAddString variantDimensionsString tastingNotesString taxStringFormatted { __typename ...FormattedString } fsaHsaEligibleString rewardProgramLabelString retailerReferenceCodeString retailerLookupCodeString itemTransparentImage { __typename ...ImageModel } itemCardHasNutritionalAttributesVariant supplierNameString supplierUrlString supplierShippingEstimateInDaysString } itemEbt { viewSection { ebtString snapString itemCardBadgeVisibilityVariant } } itemFreshFunds { viewSection { freshFundsString } } itemMedicare { viewSection { medicareString } } inStoreItemLocation { viewSection { locationIcon locationString } } }  fragment AdsFeaturedProductData on AdsFeaturedProduct { productId eligibleId itemIndex viewSection { badgeLabelString firstPixelTrackingEventName trackingProperties viewableTrackingEventName beginToRenderTrackingEventName featuredProductOutOfStockTrackingEventName sponsoredProductRiseMigrationVariant } }  fragment SearchItemResultListData on SearchItemResultList { itemIds items(first: 20, shopId: $shopId) { __typename ...ItemData } featuredProducts { __typename ...AdsFeaturedProductData } }  fragment ProductBadge on ProductBadgeResponseBackedProductBadgeBadgeSection { labelString backgroundColor labelColor positionVariant typeVariant iconImage { __typename ...ImageModel } trackingProperties itemDetailsVisibilityVariant preferenceMatchVariant suffixString }",
  "Items": "query Items($ids: [ID!]!, $shopId: ID, $hydrateItemPrice: Boolean = false , $itemShopId: ID = \"\" , $itemZoneId: ID = \"\" , $itemPostalCode: String = \"\" ) { items(ids: $ids, shopId: $shopId) { __typename ...ItemData } }  fragment TrackingEvent on Tracking { name properties }  fragment FormattedAttributesString on ViewFormattedAttributesString { sections { name text styles { backgroundColor color colorHex italic underline highlight typography } navigation { navigate { __typename ... on ViewFormattedAttributesStringNavigateToUrl { url } } } } }  fragment PriceBadge on ItemsResponseBackedItemPriceBadgeSection { badgeVariant offerLabelString actionLabelString offerReferenceString promotionClickCtaClientTrackingEventName promotionClipClientTrackingEventName trackingProperties viewableTrackingEventName couponAppliedString couponClippedVariant applyCouponString eligibleItemsUxVariant multiUnitClippablePromotionVariant itemMultiplePromotionsVariant multiplePromotionsLabelString offerBrandingFormattedAttributesString { __typename ...FormattedAttributesString } }  fragment FormattedString on ViewFormattedString { sections { name content } }  fragment ItemPromotions on ItemsResponseBackedItemPriceItemPromotionSection { applyCouponString badgeVariant couponAppliedString couponClippedVariant multiUnitClippablePromotionVariant offerLabelString offerLoadIdString offerReferenceString offerSublabelString offerUniqueIdString }  fragment ImageModel on Image { altText height width templateUrl url }  fragment SecondaryPromotion on ItemsResponseBackedItemPriceSecondaryPromotionSection { id badgeVariant logoImage { __typename ...ImageModel } offerLabelString }  fragment SizeSelectorFields on ItemsResponseBackedItemPriceSizeSelectorSection { unitLabelString priceString fullPriceString pricePerMeasureString caseLabelString casePricePerItemString casePriceString caseFullPriceString casePriceStringFormatted { __typename ...FormattedString } casePricingPerMeasureString caseQuantityString modalTitleString viewFullDetailsString loadTrackingEventName displayTrackingEventName engagementTrackingEventName }  fragment ItemPrice on ItemsItemPrice { itemId greatPrice { viewSection { labelString trackingProperties } } viewSection { itemDetails { dealAppliedLabelString totalOptionsString pricePerUnitString } badge { __typename ...PriceBadge } fullPriceString priceString itemCard { fullPriceString priceString priceDollarsString priceCentsString priceSuffixString priceBackgroundVariant pricingUnitSecondaryString pricingUnitString priceAriaLabelString trackingProperties loyaltyProgramLabelString loyaltyProgramSmallLabelString loyaltyProgramVariant loyaltyPriceStringPositionVariant loyaltyPriceStringFormatted { __typename ...FormattedString } nonLoyaltyPriceStringFormatted { __typename ...FormattedString } priceStringFormatted { __typename ...FormattedString } secondaryBottomStringFormatted { __typename ...FormattedString } secondaryTopStringFormatted { __typename ...FormattedString } loyaltyPriceStringPositionVariant smartDiscountFormattedAttributesString { __typename ...FormattedAttributesString } taxDisclaimerFormattedAttributesString { __typename ...FormattedAttributesString } } itemPromotions { __typename ...ItemPromotions } secondaryPromotion { __typename ...SecondaryPromotion } sizeSelector { __typename ...SizeSelectorFields } trackingProperties } }  fragment BlackoutTime on ItemsBlackoutTime { startHour endHour weekday }  fragment AvailabilityBadgeData on ItemsAvailability { isUpcomingProduct isItemAvailabilityLifecycleEnabled stockLevel viewSection { stockLevelLabelString stockLevelLabelColor stockLevelIconIcon upcomingProductAvailableFromString } }  fragment Quantity on ItemsQuantityAttributes { increment initial max min quantityType parWeight { quantity } viewSection { unitString maxedOutString minReachedString variableWeightDisclaimerString iconUnitTypeVisibilityVariant stepperUnitTypeVisibilityVariant totalWeightEstimateTemplatePluralString totalWeightEstimateTemplateString quantityUnitVisibilityVariant parWeightDisplayString soldByUnitString } }  fragment ItemData on ItemsItem { id itemLoadId legacyId legacyV3Id name brandName brandId productId externalSku productCategoryName configurableProductId isCatering dietary { mlShoppingAttributes viewSection { attributeSections { attributeString discoveryPageSlugString itemCardVisibilityVariant itemDetailsVisibilityVariant trackingProperties colorHexString iconImage { resizedUrl(width: 160, height: 160) } loadTrackingEvent { __typename ...TrackingEvent } displayTrackingEvent { __typename ...TrackingEvent } engagementTrackingEvent { __typename ...TrackingEvent } } } } nutritionalAttributes { id nutrient viewSection { longLabelString shortLabelString unitString valueString } } price(shopId: $itemShopId, zoneId: $itemZoneId, postalCode: $itemPostalCode) @include(if: $hydrateItemPrice) { __typename ...ItemPrice } productRating { amount value viewSection { amountString ratingColor } } productScores { nutriscore viewSection { nutritionScoreQualifierString nutritionScoreTitleString engagementTrackingEvent { __typename ...TrackingEvent } trackingProperties } } availability { __typename available blackoutTimes { __typename ...BlackoutTime } ...AvailabilityBadgeData viewSection { warningIconImage { __typename ...ImageModel } outOfStockCtaString } } quantityAttributes { __typename ...Quantity } retailerId size tags variantDimensionValues variantGroupId variantGroup { viewSection { optionsSummaryString itemCardSubtextStringFormatted { __typename ...FormattedString } variantsItemCardSubtextStringFormatted { __typename ...FormattedString } variantsItemCardSubtextSimpleStringFormatted { __typename ...FormattedString } trackingProperties } } viewSection { itemString itemImage { __typename ...ImageModel } lowStockVariant itemCardHideQuickAddPriceVariant trackingProperties requestAddString variantDimensionsString tastingNotesString taxStringFormatted { __typename ...FormattedString } fsaHsaEligibleString rewardProgramLabelString retailerReferenceCodeString retailerLookupCodeString itemTransparentImage { __typename ...ImageModel } itemCardHasNutritionalAttributesVariant supplierNameString supplierUrlString supplierShippingEstimateInDaysString } itemEbt { viewSection { ebtString snapString itemCardBadgeVisibilityVariant } } itemFreshFunds { viewSection { freshFundsString } } itemMedicare { viewSection { medicareString } } inStoreItemLocation { viewSection { locationIcon locationString } } }",
  "ItemDetail": "query ItemDetail($shopId: ID!, $id: ID!) { itemDetail(shopId: $shopId, id: $id) { cpgCouponId promotionGroupId id shareLink itemEbt { viewSection { ebtString ebtAriaString snapString } } itemFreshFunds { viewSection { freshFundsString } } itemMedicare { viewSection { medicareString } } viewSection { addToListVariant addToListCtaString addToListCoachmarkString browseByDietaryAttributesVariant carouselSection { featuredProductDisclaimerString featuredProductSuggestionTitleString featuredProductSuggestionVariant alcoholSuggestionTitleString alcoholSuggestionVariant alcoholSuggestionFullySponsoredVariant recommendationsSuggestionTitleString recommendationsSuggestionVariant replacementsSuggestionTitleString replacementsSuggestionVariant carousels { carouselTypeVariant trackingProperties } viewMoreString } freeDeliveryString freePickupString legalDisclaimerFormattedAttributesString { __typename ...FormattedAttributesString } multiDimensionalSupportVariant prop65WarningSection { headerString bodyString positionVariant } regimenSection { headerString atcCtaForAllRemainingString atcCtaForNoneRemainingString atcCtaForOneRemainingString atcCtaForSomeRemainingString regimenItemClickTrackingEventName regimenViewTrackingEventName } displayAdSection { placementTypeString displayPositionNumberString } detailSections { headerString bodyString sectionTypeVariant } productDetailSections { id headerString bodyString } detailImages { __typename ...ImageModel } returnInfoVariant trackingProperties rewardProgramImage { __typename ...ImageModel } rewardProgramLabelString } } viewLayout { itemDetail { multiRetailerItem { showAllStoresString showFewerStoresString } itemDetailsV4 { densificationVariant itemDetailsV2ProductAttributesRedesignVariant itemDetailsV2RedesignVariant nutritionBreakdownVariant showBadgesInItemDetailsVariant showDietaryWizardEntryVariant eligibleForString showEligibleItemsPromotionModalVariant itemDetailsVariantsPpuVariant showEligibleItemsPromotionModalRedesignVariant itemSummaryAndNotesRedesignVariant srxPdpNutriscoreVariant itemDetailsBrandBreadcrumbsVariant } detailSection { applyHealthStyleTreatmentVariant detailDisclaimerFormattedAttributesString { __typename ...FormattedAttributesString } headerString nutriscoreDenominatorString nutriscoreDescriptionString nutriscoreReferenceLinkString nutriscoreTitleString nutritionHeaderString seeLessString shopAllString aboutNutritionTitleString alwaysCheckProductPackagingString disclaimerConfirmationString aboutNutritionDisclaimerFormattedAttributesString { __typename ...FormattedAttributesString } } } } }  fragment FormattedAttributesString on ViewFormattedAttributesString { sections { name text styles { backgroundColor color colorHex italic underline highlight typography } navigation { navigate { __typename ... on ViewFormattedAttributesStringNavigateToUrl { url } } } } }  fragment ImageModel on Image { altText height width templateUrl url }",
  "ItemPrices": "query ItemPrices($shopId: ID!, $zoneId: ID!, $postalCode: String!, $ids: [ID!]!) { itemPricesV2(shopId: $shopId, zoneId: $zoneId, postalCode: $postalCode, itemIds: $ids) { __typename ...ItemPrice } }  fragment FormattedAttributesString on ViewFormattedAttributesString { sections { name text styles { backgroundColor color colorHex italic underline highlight typography } navigation { navigate { __typename ... on ViewFormattedAttributesStringNavigateToUrl { url } } } } }  fragment PriceBadge on ItemsResponseBackedItemPriceBadgeSection { badgeVariant offerLabelString actionLabelString offerReferenceString promotionClickCtaClientTrackingEventName promotionClipClientTrackingEventName trackingProperties viewableTrackingEventName couponAppliedString couponClippedVariant applyCouponString eligibleItemsUxVariant multiUnitClippablePromotionVariant itemMultiplePromotionsVariant multiplePromotionsLabelString offerBrandingFormattedAttributesString { __typename ...FormattedAttributesString } }  fragment FormattedString on ViewFormattedString { sections { name content } }  fragment ItemPromotions on ItemsResponseBackedItemPriceItemPromotionSection { applyCouponString badgeVariant couponAppliedString couponClippedVariant multiUnitClippablePromotionVariant offerLabelString offerLoadIdString offerReferenceString offerSublabelString offerUniqueIdString }  fragment ImageModel on Image { altText height width templateUrl url }  fragment SecondaryPromotion on ItemsResponseBackedItemPriceSecondaryPromotionSection { id badgeVariant logoImage { __typename ...ImageModel } offerLabelString }  fragment SizeSelectorFields on ItemsResponseBackedItemPriceSizeSelectorSection { unitLabelString priceString fullPriceString pricePerMeasureString caseLabelString casePricePerItemString casePriceString caseFullPriceString casePriceStringFormatted { __typename ...FormattedString } casePricingPerMeasureString caseQuantityString modalTitleString viewFullDetailsString loadTrackingEventName displayTrackingEventName engagementTrackingEventName }  fragment ItemPrice on ItemsItemPrice { itemId greatPrice { viewSection { labelString trackingProperties } } viewSection { itemDetails { dealAppliedLabelString totalOptionsString pricePerUnitString } badge { __typename ...PriceBadge } fullPriceString priceString itemCard { fullPriceString priceString priceDollarsString priceCentsString priceSuffixString priceBackgroundVariant pricingUnitSecondaryString pricingUnitString priceAriaLabelString trackingProperties loyaltyProgramLabelString loyaltyProgramSmallLabelString loyaltyProgramVariant loyaltyPriceStringPositionVariant loyaltyPriceStringFormatted { __typename ...FormattedString } nonLoyaltyPriceStringFormatted { __typename ...FormattedString } priceStringFormatted { __typename ...FormattedString } secondaryBottomStringFormatted { __typename ...FormattedString } secondaryTopStringFormatted { __typename ...FormattedString } loyaltyPriceStringPositionVariant smartDiscountFormattedAttributesString { __typename ...FormattedAttributesString } taxDisclaimerFormattedAttributesString { __typename ...FormattedAttributesString } } itemPromotions { __typename ...ItemPromotions } secondaryPromotion { __typename ...SecondaryPromotion } sizeSelector { __typename ...SizeSelectorFields } trackingProperties } }",
  "SearchFacets": "query SearchFacets($shopId: ID!, $postalCode: String!, $query: String!, $filters: [FilterInput!] = [] ) { searchFacets(shopId: $shopId, postalCode: $postalCode, query: $query, filters: $filters) { viewSection { labelString } multiselect filters { disabled key value viewSection { labelString iconBackgroundColorHexString iconImage { __typename ...ImageModel } } subfilters { key value viewSection { labelString iconBackgroundColorHexString iconImage { __typename ...ImageModel } } } } } viewLayout { searchResults { sort { bestMatchLabelString priceAscLabelString priceDescLabelString sortByString } filters { applyString resetString } } } }  fragment ImageModel on Image { altText height width templateUrl url }"
});

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENT';
  throw error;
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) invalid(`${name} must be a nonempty string.`);
  return value;
}

function idsArgument(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    invalid('ids must contain between 1 and 100 nonempty item IDs.');
  }
  return ids;
}

function limitArgument(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be an integer between 1 and 100.');
  return limit;
}

function execute(client, name, variables) {
  return client.graphql(name, CATALOG_DOCUMENTS[name], variables);
}

function normalizeShop(shop) {
  return {
    shopId: shop.id,
    retailerId: shop.retailer?.id,
    retailerLocationId: shop.retailerLocationId,
    name: shop.retailer?.name,
    slug: shop.retailer?.slug,
    serviceType: shop.serviceType,
    retailerType: shop.retailer?.retailerType,
    imageUrl: shop.retailer?.viewSection?.logoImage?.url,
    deliveryDescription: shop.viewSection?.deliveryString,
    pickupDescription: shop.viewSection?.pickupString,
  };
}

export function normalizeItem(value) {
  return {
    id: value.id,
    productId: value.productId,
    legacyId: value.legacyId,
    name: value.name,
    brand: value.brandName,
    size: value.size,
    retailerId: value.retailerId,
    available: value.availability?.available,
    imageUrl: value.viewSection?.itemImage?.url,
    price: value.price?.viewSection?.priceString ?? value.price?.viewSection?.itemCard?.priceString,
    quantity: value.quantityAttributes ? {
      type: value.quantityAttributes.quantityType,
      initial: value.quantityAttributes.initial,
      minimum: value.quantityAttributes.min,
      maximum: value.quantityAttributes.max,
      increment: value.quantityAttributes.increment,
      unit: value.quantityAttributes.viewSection?.unitString,
    } : undefined,
    rating: value.productRating ? { value: value.productRating.value, count: value.productRating.amount } : undefined,
  };
}

export async function addresses(client) {
  const data = await execute(client, 'UserAddresses', {});
  return { addresses: data.userAddresses ?? [] };
}

export async function stores(client, options = {}) {
  const postalCode = required(options.postalCode, 'postalCode');
  const { latitude, longitude } = options;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    invalid('Valid latitude and longitude are required to find serviceable stores.');
  }
  if (options.query !== undefined) required(options.query, 'query');
  if (options.serviceType !== undefined && !['delivery', 'pickup'].includes(options.serviceType)) {
    invalid('serviceType must be delivery or pickup.');
  }
  if (options.retailerIds !== undefined) idsArgument(options.retailerIds);
  const variables = { postalCode, coordinates: { latitude, longitude } };
  if (options.addressId) variables.addressId = required(options.addressId, 'addressId');
  if (options.retailerIds) variables.retailerIds = options.retailerIds;
  const data = await execute(client, options.retailerIds ? 'ShopCollectionScoped' : 'ShopCollectionUnscoped', variables);
  const query = options.query?.toLocaleLowerCase();
  const shops = (data.shopCollection?.shops ?? []).filter(shop =>
    (!options.serviceType || shop.serviceType === options.serviceType) &&
    (!query || [shop.retailer?.name, shop.retailer?.slug].some(value => value?.toLocaleLowerCase().includes(query)))
  );
  return { postalCode, stores: shops.map(normalizeShop), total: shops.length };
}

export async function shop(client, { shopId } = {}) {
  const data = await execute(client, 'Shop', { shopId: required(shopId, 'shopId') });
  return { shop: data.shop ? normalizeShop(data.shop) : null };
}

export async function items(client, options = {}) {
  const variables = { ids: idsArgument(options.ids) };
  if (options.shopId) variables.shopId = required(options.shopId, 'shopId');
  if (options.zoneId || options.postalCode) {
    variables.hydrateItemPrice = true;
    variables.itemShopId = required(options.shopId, 'shopId');
    variables.itemZoneId = required(options.zoneId, 'zoneId');
    variables.itemPostalCode = required(options.postalCode, 'postalCode');
  }
  const data = await execute(client, 'Items', variables);
  return { items: (data.items ?? []).filter(Boolean).map(normalizeItem) };
}

export async function item(client, options = {}) {
  if (Boolean(options.zoneId) !== Boolean(options.postalCode)) invalid('Supply zoneId and postalCode together for product prices.');
  const shopId = required(options.shopId, 'shopId');
  const id = required(options.id, 'id');
  const [summary, detail] = await Promise.all([
    items(client, { shopId, ids: [id], ...(options.zoneId ? { zoneId: options.zoneId, postalCode: options.postalCode } : {}) }),
    execute(client, 'ItemDetail', { shopId, id }),
  ]);
  return { item: summary.items[0] ?? null, details: detail.itemDetail ?? null };
}

export async function prices(client, options = {}) {
  const data = await execute(client, 'ItemPrices', {
    shopId: required(options.shopId, 'shopId'),
    zoneId: required(options.zoneId, 'zoneId'),
    postalCode: required(options.postalCode, 'postalCode'),
    ids: idsArgument(options.ids),
  });
  return { prices: (data.itemPricesV2 ?? []).map(value => ({
    itemId: value.itemId,
    price: value.viewSection?.priceString,
    fullPrice: value.viewSection?.fullPriceString,
    details: value.viewSection,
  })) };
}

export async function facets(client, options = {}) {
  if (options.filters !== undefined && (!Array.isArray(options.filters) || options.filters.some(filter =>
    !filter || typeof filter.key !== 'string' || typeof filter.value !== 'string'))) invalid('filters must be an array of {key, value} objects.');
  const data = await execute(client, 'SearchFacets', {
    shopId: required(options.shopId, 'shopId'),
    postalCode: required(options.postalCode, 'postalCode'),
    query: required(options.query, 'query'),
    filters: options.filters ?? [],
  });
  return { facets: data.searchFacets ?? [] };
}

function searchContext(options) {
  return {
    shopId: required(options.shopId, 'shopId'),
    postalCode: required(options.postalCode, 'postalCode'),
    query: required(options.query, 'query'),
    zoneId: options.zoneId === undefined ? null : required(options.zoneId, 'zoneId'),
    includeAds: options.includeAds ?? false,
  };
}

function fingerprint(context) {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

function decodeCursor(value, context) {
  if (typeof value !== 'string' || value.length > 1000000 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid('Invalid search cursor.');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { invalid('Invalid search cursor.'); }
  if (cursor?.v !== 1 || cursor.context !== fingerprint(context) || !Array.isArray(cursor.ids) || cursor.ids.length > 20000 ||
    cursor.ids.some(id => typeof id !== 'string' || !id || id.length > 256) ||
    !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > cursor.ids.length ||
    !Number.isFinite(cursor.expiresAt) || cursor.expiresAt < Date.now() || cursor.expiresAt > Date.now() + 31 * 60 * 1000) {
    invalid('Search cursor is expired, invalid, or belongs to a different search.');
  }
  return cursor;
}

/** Pagination preserves the native ranked ID snapshot; subsequent pages hydrate via Items. */
export async function search(client, options = {}) {
  const context = searchContext(options);
  if (typeof context.includeAds !== 'boolean') invalid('includeAds must be a boolean.');
  const limit = limitArgument(options.limit);
  let snapshot;
  let loaded = [];
  let warnings;
  if (options.cursor) {
    snapshot = decodeCursor(options.cursor, context);
  } else {
    const variables = {
      shopId: context.shopId, postalCode: context.postalCode, query: context.query,
      searchSource: 'search', searchOptions: { includeAds: context.includeAds },
    };
    if (context.zoneId) Object.assign(variables, { hydrateItemPrice: true, itemShopId: context.shopId, itemZoneId: context.zoneId, itemPostalCode: context.postalCode });
    const data = await execute(client, 'SearchItems', variables);
    const result = data.itemSearch?.itemResultList;
    loaded = result?.items?.filter(Boolean) ?? [];
    const ids = result?.itemIds ?? loaded.map(value => value.id);
    if (!Array.isArray(ids) || ids.length > 20000 || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) {
      const error = new Error('Instacart returned an invalid item ID list.');
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    snapshot = { v: 1, context: fingerprint(context), ids, offset: 0, expiresAt: Date.now() + 30 * 60 * 1000 };
    warnings = data.itemSearch?.viewSection?.zeroItemResult;
  }
  const pageIds = snapshot.ids.slice(snapshot.offset, snapshot.offset + limit);
  const byId = new Map(loaded.map(value => [value.id, normalizeItem(value)]));
  const missing = pageIds.filter(id => !byId.has(id));
  if (missing.length) {
    const hydrated = await items(client, {
      shopId: context.shopId, ids: missing,
      ...(context.zoneId ? { zoneId: context.zoneId, postalCode: context.postalCode } : {}),
    });
    for (const value of hydrated.items) byId.set(value.id, value);
  }
  const offset = snapshot.offset;
  snapshot.offset += pageIds.length;
  const hasMore = snapshot.offset < snapshot.ids.length;
  return {
    shopId: context.shopId, postalCode: context.postalCode, query: context.query,
    items: pageIds.map(id => byId.get(id)).filter(Boolean),
    missingItemIds: pageIds.filter(id => !byId.has(id)),
    total: snapshot.ids.length, offset, hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify(snapshot)).toString('base64url') : null,
    ...(warnings ? { notices: warnings } : {}),
  };
}
