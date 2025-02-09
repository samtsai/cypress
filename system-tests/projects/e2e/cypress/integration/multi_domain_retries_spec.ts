describe('cy.origin test retries', () => {
  beforeEach(() => {
    cy.visit('/multi_domain.html')
    cy.get('a[data-cy="cross_origin_secondary_link"]').click()
  })

  it('appropriately retries test within "cy.origin" without propagating other errors errors', function () {
    cy.origin('http://foobar.com:4466', () => {
      cy.then(() => {
        expect(true).to.be.false
      })
    })
  })
})
